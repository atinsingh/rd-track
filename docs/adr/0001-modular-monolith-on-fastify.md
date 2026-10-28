# ADR-0001: Modular monolith on Fastify + TypeScript

**Status:** Accepted · 2026-10-28

## Context

The requirements recommend a modular monolith with asynchronous workers, and suggest
"NestJS/TypeScript or the team's equivalent mature framework". Initial scale is 50–250
employees, with a tested path to 1,000+.

## Decision

* One TypeScript codebase (`apps/api`) with two entry points: the HTTP API and the worker.
* **Fastify 5** instead of NestJS. Module boundaries are folders (`src/modules/<name>`)
  exporting a service and a route plugin; dependencies are wired explicitly in
  `src/app.ts`. Validation uses the same Zod schemas the web app imports from
  `packages/contracts`.
* **Plain SQL** through `pg` with numbered migration files. Reporting queries are the
  heart of this product, and they are clearer as SQL than as ORM calls.

## Consequences

* Less framework surface: no decorators, no reflection metadata, fast tests via
  `app.inject()`. The trade-off is that conventions (module layout, how a route declares
  its auth mode) are ours to keep consistent — `src/modules/README.md` documents them.
* If RoundDigital's team is already fluent in NestJS, the module layout maps one-to-one
  onto Nest modules; the services carry no Fastify types.
