# RoundDigital Track

A transparent work-session, project-time and computer-activity platform for RoundDigital:
employee-controlled sessions, aggregated activity (counts, never content), optional
policy-governed screenshots, and employee access to everything managers can see.

## Design

- [System design](docs/design/01-system-design.md): architecture, data model, wire contracts, key flows, security, testing
- [UX design](docs/design/02-ux-design.md): information architecture, screens, wording rules, plus the [visual mockups](https://claude.ai/artifact/FyvyFXt9rY4rjiusnKxnAM)
- Architecture decisions: [`docs/adr`](docs/adr)

## Repository layout (planned)

| Path | What |
|---|---|
| `packages/contracts` | Shared Zod schemas: event envelope, policy settings and resolver, API DTOs |
| `apps/api` | Fastify API (modular monolith) and worker |
| `apps/web` | Next.js dashboard for employees, managers, admins and auditors |
| `agent/` | Rust desktop agent (core library and headless binary) |
| `infra/` | Local Postgres and MinIO |
