# ADR-0002: Postgres-backed job queue first, SQS later if needed

**Status:** Accepted · 2026-10-28

## Context

Ingestion must never lose an acknowledged event, and replays must be harmless. The
requirements suggest SQS. An external queue means the API has to write to two systems on
every batch — Postgres (raw events) and SQS (the job) — and a crash between the two either
loses the job or enqueues work for data that never committed.

## Decision

Jobs live in a `jobs` table in the same database. The ingestion transaction inserts the
raw events **and** the job, then commits, then acknowledges. Workers claim jobs with
`SELECT … FOR UPDATE SKIP LOCKED`, retry with exponential backoff, and park a job as
`failed` after `max_attempts`.

The queue sits behind a small interface (`enqueue`, `claim`, `complete`, `fail`) so an SQS
implementation (with a transactional outbox) can replace it without touching modules.

## Consequences

* Exactly one source of truth and one backup/restore story.
* Expected load is modest: 250 employees × one batch per minute ≈ 4 jobs/s at peak, well
  within a single Postgres instance. Revisit when sustained job throughput exceeds
  ~200/s or worker lag p95 exceeds 60 s.
