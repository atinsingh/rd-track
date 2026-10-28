# syntax=docker/dockerfile:1
# Build context: repository root.  docker build -f apps/api/Dockerfile .
FROM node:22.21-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @rd/api...
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @rd/api build && pnpm deploy --filter @rd/api --prod --legacy /out && cp -r apps/api/dist /out/dist

FROM node:22.21-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out /app
# Amazon RDS CA bundle: DATABASE_URL uses sslmode=verify-full&sslrootcert=<this path>
# (infra/terraform/modules/app-stack), so the database certificate and hostname are
# verified. Root-owned, world-readable. The directory is created first: ADD --chmod
# would otherwise give the parent directory 0644 and make the file unreachable.
RUN mkdir -p /usr/local/share/rds
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /usr/local/share/rds/rds-global-bundle.pem
USER node
EXPOSE 4000
# Same image runs the API (default), the worker (`node dist/worker.js`)
# and migrations (`node dist/db/migrate-cli.js`).
CMD ["node", "dist/main.js"]
