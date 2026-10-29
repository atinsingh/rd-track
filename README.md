# RoundDigital Track

A transparent work-session, project-time and computer-activity platform, sold as
multi-tenant SaaS (Free up to 2 tracked users · Standard $2.50 · Pro $5 per user per month on an annual
term, or $5 / $10 month to month).

- Employees explicitly start and stop work sessions; nothing is collected outside them.
- Activity is aggregated per minute (counts, never keys or content); app names only.
- Screenshots are off unless a published, versioned policy turns them on — and every view
  is audited and visible to the employee.
- Employees see everything their manager can see about them.

## Design

| Document | What's in it |
|---|---|
| [System design](docs/design/01-system-design.md) | Architecture, roles, data model, agent/web wire contracts, key flows, time integrity, security, testing |
| [UX design](docs/design/02-ux-design.md) + [visual mockups](https://claude.ai/artifact/FyvyFXt9rY4rjiusnKxnAM) | Information architecture, screens, wording rules, RoundDigital visual system |
| [Commercial model](docs/design/03-commercial-model.md) | Plans and prices, seat definition, licence enforcement, multi-tenancy |
| [ADRs](docs/adr) | Fastify modular monolith · Postgres job queue · partial-policy resolution · multi-tenant SaaS |

## Repository

| Path | What |
|---|---|
| `packages/contracts` | Shared Zod schemas and types: event envelope, policy model and resolver, plans, API DTOs |
| `apps/api` | Fastify API (`src/main.ts`) and worker (`src/worker.ts`) on PostgreSQL |
| `apps/web` | Next.js dashboard with a home for each role: employees, managers, admins, finance and auditors |
| `agent/` | Rust desktop agent: `rd-agent-core` library and `rd-agent` headless binary |
| `infra/` | Local Postgres + MinIO (`docker compose`) |
| `scripts/e2e-agent.sh` | Real agent against real API + worker, reconciled in SQL |

## Run it locally

Requirements: Node 22 + pnpm 10, PostgreSQL 16, Rust (for the agent).

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d     # or use a local Postgres
cp apps/api/.env.example apps/api/.env               # STORAGE=local needs no MinIO
pnpm db:seed                                         # migrates + demo org "RoundDigital"
pnpm dev:api                                         # http://localhost:4000
pnpm dev:worker
pnpm dev:web                                         # http://localhost:3000
```

The seed prints demo sign-ins (password `track-demo-2026`): an org admin, a team manager
(Priya), employees, an auditor and a finance user, with a week of synthetic sessions. Each lands on
their own home: My day, Team today, Setup and health, Period close or the audit log.

Run a desktop agent against it (simulated input — native collectors come next):

```bash
cd agent && cargo build -p rd-agent
./target/debug/rd-agent enroll --server http://localhost:4000 --code <code from Admin → Devices>
./target/debug/rd-agent run --simulate --project <project uuid> --duration 300
```

## Tests

```bash
pnpm --filter @rd/contracts test       # policy resolver, schema strictness
pnpm --filter @rd/api test             # integration tests on real Postgres (TEST_DATABASE_URL)
pnpm --filter @rd/web test
(cd agent && cargo test --workspace)
./scripts/e2e-agent.sh                 # agent ↔ API end to end
```

## Status of this increment

Built: design; contracts; API and worker (auth + TOTP MFA, tenants, platform operators,
plans and seat enforcement, policies with expansion confirmation and signed delivery,
ingestion, sessions, activity/app reports, screenshots, corrections, exports, retention
with legal hold, audit); web dashboard; Rust agent core with simulated platform; CI.

Next: native Windows/macOS collectors and the Tauri tray UI; signed installers and
auto-update; Stripe billing provider and self-serve signup; SSO/SCIM; Postgres row-level
security as defence in depth; Terraform for AWS. Commercial open questions are listed in
the commercial model §8.
