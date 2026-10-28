# ADR-0003: Partial policies with per-field resolution strategies

**Status:** Accepted · 2026-10-28

## Context

`POL-02`: resolve policy by organization → team → project/device, with the most
privacy-restrictive setting winning on conflict.

Read literally as "each lower scope can only tighten", turning screenshots on for one
project requires enabling them for the whole organization and then disabling them for
every other team — and any team created later gets screenshots by default. That is the
opposite of what the requirement is for.

## Decision

* Every scope holds a **partial** settings document. Absence means "no opinion".
* Each field declares a resolution strategy (see the table in the system design §6.4).
  The key one, *restrictive boolean*: any explicit `false` wins; otherwise any explicit
  `true`; otherwise the privacy-preserving default.
* Numeric fields resolve toward less collection (longer screenshot interval, shorter
  retention, smaller image width).
* Operational, non-collection fields (idle threshold, offline metadata buffer) take the
  most specific value.
* The resolver is a pure function in `packages/contracts` with table-driven tests. The
  agent never resolves policy itself; it receives the resolved, signed document.

## Consequences

* Screenshots can be enabled for exactly one project, and any team, project or device can
  veto them. "Conflict" means an explicit disagreement, not a missing value.
* Publishing must evaluate effective policies of affected employees to detect
  expansions (`POL-05`) — done with the same resolver, before/after.
