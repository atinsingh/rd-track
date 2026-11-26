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
# Work location (policy `location.capture`): DB-IP "IP to City Lite" (CC BY 4.0, no key), read
# offline so no employee IP leaves the server. DB-IP only serves the current month (older
# files 404), so this month's file is fetched, else last month's. Best effort: a failed fetch
# never fails the build; IPs are then stored without a city (docs/runbooks/deploy.md §2.1).
RUN mkdir -p /usr/local/share/geoip && node -e "\
  const zlib = require('node:zlib'), fs = require('node:fs');\
  const month = (back) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back); return d.toISOString().slice(0, 7); };\
  (async () => { for (const m of [month(0), month(1)]) {\
    const r = await fetch('https://download.db-ip.com/free/dbip-city-lite-' + m + '.mmdb.gz');\
    if (!r.ok) continue;\
    fs.writeFileSync('/usr/local/share/geoip/dbip-city-lite.mmdb', zlib.gunzipSync(Buffer.from(await r.arrayBuffer())));\
    return console.log('GeoIP ' + m);\
  } console.warn('GeoIP database not downloaded'); })().catch((e) => console.warn('GeoIP database not downloaded', e));"
ENV GEOIP_DB_PATH=/usr/local/share/geoip/dbip-city-lite.mmdb
USER node
EXPOSE 4000
# Same image runs the API (default), the worker (`node dist/worker.js`)
# and migrations (`node dist/db/migrate-cli.js`).
CMD ["node", "dist/main.js"]
