# syntax=docker/dockerfile:1
# Build context: repository root.
#   docker build -f apps/web/Dockerfile --build-arg API_URL=https://track.example.com .
#
# Requires `output: 'standalone'` in apps/web/next.config.ts: the runtime image holds
# only the traced server bundle, not the workspace's node_modules.
FROM node:22.21-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @rd/web...
COPY packages/contracts packages/contracts
COPY apps/web apps/web

# next.config.ts rewrites /v1/* to API_URL, and Next bakes rewrites into the build
# output, so the target is fixed per image. Behind the ALB /v1/* goes straight to the
# API and this rewrite is only a fallback; the deploy workflow passes https://<app host>.
ARG API_URL
ENV API_URL=${API_URL} \
    NEXT_TELEMETRY_DISABLED=1
RUN test -n "$API_URL" || { echo "build arg API_URL is required" >&2; exit 1; }
RUN pnpm --filter @rd/web build
RUN test -f apps/web/.next/standalone/apps/web/server.js \
 || { echo "apps/web/.next/standalone missing: set output: 'standalone' in apps/web/next.config.ts" >&2; exit 1; }

FROM node:22.21-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Code is root-owned and read-only to the runtime user; only Next's cache is writable.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
