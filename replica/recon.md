# Recon map: Hubstaff (web, desktop, mobile)

Scope: the workforce / time-tracking feature set, measured against what RoundDigital Track already ships.
For: RoundDigital Track — a privacy-first alternative sold per seat. This is a gap analysis, not a clone:
we rebuild functionality only where it fits the requirements (transparent, employee-first, no keystrokes,
screenshots off by default).
Date: 2026-10-28

Method: `/replica-recon` (replica-skill v1.0). hubstaff.com, its help center, G2, Capterra and the App
Store cannot be fetched from this environment, so every row comes from **web-search summaries** of the
sources below — no pages were read in full and no screenshots were taken (`replica/screens/` is empty).
Treat plan placement and prices as unconfirmed. Updates `docs/design/05-competitive-gap-analysis.md`.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | changelog | https://hubstaff.com/blog/whats-new-at-hubstaff-q1-2026-feature-updates/ | Time & Activity redesign, batch manual-time approvals, PTO accrual timing, performance widgets, API endpoints |
| 2 | changelog | https://hubstaff.com/blog/what-is-new/ | 2025: timesheet approvals redesign, manual time approvals, Insights timeline, AI unusual activity, AI tools category |
| 3 | pricing (third party) | https://www.capterra.com/p/132376/Hubstaff/pricing/ | Starter / Grow / Team / Enterprise; add-ons ~$2.50/seat |
| 4 | help center | https://support.hubstaff.com/job-sites/ | job sites, geofenced timers (Locations add-on) |
| 5 | help center | https://support.hubstaff.com/how-does-the-inactivity-warning-work/ | idle timeout; keep idle: prompt / always / never |
| 6 | help center | https://support.hubstaff.com/reports-overview/ | reports list incl. amounts owed, payments, manual time edits, audit log |
| 7 | help center | https://support.hubstaff.com/payroll-overview/ | payouts (Wise, PayPal, Payoneer, Bitwage, Deel, Gusto), adjustments, one-time amounts |
| 8 | help center | https://support.hubstaff.com/hubstaff-user-rolepermissions-guide/ | owner, org manager, project manager, viewer, user, team lead |
| 9 | help center | https://support.hubstaff.com/hubstaff-insights-add-on/ | Insights: performance page, utilization targets, meetings, unusual activity |
| 10 | public API docs | https://developer.hubstaff.com/ | API v2: OAuth/OIDC, org + personal access tokens, webhooks, time off, manual time requests |
| 11 | press | https://www.webull.com/news/15554990639539200 | Sept 2026: CLI, MCP server for AI agents |

## Core loop

The desktop timer records time against a project. Activity and proof (activity %, apps, screenshots)
roll up into approved timesheets, which drive payroll and client invoices.

## Screens (Hubstaff areas relevant to the gaps)

| ID | screen | how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Desktop timer | tray / app | start/stop, project/task, today total | timer, pickers | tracking, paused, offline |
| S02 | Idle prompt | desktop, after idle timeout | keep / discard / reassign idle time | modal, project picker | prompt (Always/Never skip it) |
| S03 | Timesheets approvals | Timesheets → Approvals | review many weeks at once | table, filters, batch bar | pending, approved, denied |
| S04 | Manual time requests | Timesheets → Manual time | approve/deny entries, batch | list, batch actions | pending, empty |
| S05 | Performance (Insights) | Insights → Performance | utilization vs target, avg start/stop, idle, focus, meetings | widgets, PDF/CSV export | remote vs office tab |
| S06 | Insights timeline | Insights → Timeline | one day: activity, idle, manual, PTO | timeline lanes | — |
| S07 | Payroll | Financials → Payroll | pay hours via providers, adjustments, payslips | payment table, provider status | processing, paid |
| S08 | Expenses | Financials → Expenses | expenses per project, into invoices | form, list | — |
| S09 | Reports | Reports → All reports | amounts owed, payments, manual time edits, audit log, work sessions | report tables, export | — |
| S10 | Members → limits / expected hours | People → Members | weekly limits, expected hours (utilization) | per-member settings | — |
| S11 | Job sites | Locations | geofences, CSV import | map, radius | (skip: non-goal) |
| S12 | Developer portal | developer.hubstaff.com | tokens, webhooks, endpoints | — | — |

## Flows

```
F01 Employee returns from idle (Keep idle = Prompt)
    S01 tracking -> idle timeout -> S02 prompt -> keep | discard | reassign -> S01 resumes
    happy path clicks: 1-2
    edge: idle spans midnight / a week lock; agent offline; laptop asleep; Always/Never skip the prompt

F02 Manager clears a week of approvals
    S03 filter "pending, this week" -> select all -> approve -> confirm
    happy path clicks: 3 (vs one-by-one today in Track)
    edge: mixed selection incl. own timesheet; some changed since submission

F03 Manager checks utilization
    S10 set expected hours -> S05 utilization widget shows under / over target
    edge: part-time, time off, holidays (should reduce expected hours)

F04 Owner pays the team
    S09 amounts owed -> S07 create payment (+ bonus / reimbursement adjustment) -> provider -> paid + payslip
    edge: fixed-rate members (not in amounts owed), currency, provider rejects

F05 Integrator automates
    S12 create personal / org token -> call API -> subscribe webhooks
```

## Components

Batch action bar (select all, count, approve / deny with note) · Expected-hours / utilization meter ·
Idle prompt modal with project picker · Payment status badge (processing / paid / failed) · Token list with
scopes and expiry. Everything else maps onto Track's existing UI kit.

## Inferred data model (for the gaps only)

```
IdleDecision   session_id, user_id, start_at, end_at, decision (keep | discard | reassign),
               reassigned_project_id?, decided_at
               evidence: S02, help "keep idle time"           confidence: medium

ExpectedHours  org_id, user_id?, weekly_minutes, effective_from
               evidence: S05/S10, help "utilization"          confidence: medium

Expense        org_id, user_id, project_id, client_id?, date, amount_cents, currency,
               category, note, receipt_object_key?, status (pending | approved | rejected),
               invoice_line_id?
               evidence: blog "expense tracking", payroll overview confidence: guess

PayrollAdjustment  org_id, user_id, kind (bonus | deduction | reimbursement | other),
               amount_cents, currency, recurring (none | per_period), applies_from, note
               evidence: payroll overview, Q1 2026 changelog  confidence: medium

ApiToken       org_id, user_id?, name, scopes (read | write), token_hash, last_used_at,
               expires_at (≤ 90 days for personal)
               evidence: developer portal authentication      confidence: high
```

Relationships: User 1-n IdleDecision; Project 1-n Expense; Expense 0-1 InvoiceLine; User 1-n PayrollAdjustment.

## Feature matrix

See `features.csv`. `clone` is Track's status today, so `replica-diff/parity.py` scores where Track stands.
Must: 19, should: 22, could: 17, skip: 5. **Parity 62.6 / 100; must-haves 18 of 19.**

## Out of scope (cannot or should not be cloned)

- **Unusual / suspicious activity detection, incl. the AI version**: declined. It is surveillance-first; Track shows data-quality gaps instead.
- **Remote-vs-office location analytics, GPS, geofenced job sites, mobile apps**: these need location tracking, a non-goal in the requirements.
- **Hubstaff Tasks (kanban)**: declined. Track integrates with existing tools instead.
- **Payout provider network** (Wise, PayPal …): only via their official APIs, and providers hold the funds.
- **Screenshot quotas as a pricing lever**: not our model.

## Size

12 screens, 5 flows, 5 new entities. Hard parts: the idle prompt across offline and agent restarts;
payroll payouts (provider APIs, KYC, money movement); calendar integrations for meetings.

Without payouts and calendar: **M** (a few weeks). Build order:

1. Idle keep/discard prompt (the only missing must-have).
2. Batch approvals.
3. Agent limit warnings and reminders.
4. API tokens (we already advertise a REST API on Pro).
5. Utilization targets.
6. Expenses and payroll adjustments.
