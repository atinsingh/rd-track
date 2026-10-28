# Competitive gap analysis — Hubstaff vs RoundDigital Track

**Status:** Accepted for Stage 3 · **Date:** 2026-10-28

Sources: Hubstaff's public product and support pages and independent reviews (October 2026).
Hubstaff's own pages couldn't be fetched directly from our build environment, so feature
details come from search summaries of those pages; re-check specifics before marketing claims.

## How we decide

Track competes on **trusted records employees accept**. A Hubstaff feature is adopted when it
helps people run work (time, pay, schedules, budgets, wellbeing); it is **adapted** when it
can be made transparent and employee-first; it is **declined** when it only exists to watch
people more closely. Declined items are listed so sales can explain the choice.

## Feature map

| Area | Hubstaff | Track today | Decision |
|---|---|---|---|
| Time tracking (desktop, offline, idle) | ✓ | ✓ (agent, offline outbox, idle) | — |
| Activity levels, app usage | ✓ | ✓ (minute aggregates, app names) | — |
| URLs | Full URLs | Domains only, opt-in | Keep stricter |
| Screenshots | ✓ (incl. blur) | ✓ policy-governed, off by default | Blur/redaction later (SCR-12) |
| Manual time with reason | ✓ | ✓ with approval | — |
| **Timesheets & approvals** (weekly submit → approve, locked for payroll) | Grow+ | ✗ | **Adopt — Stage 3** |
| **Daily/weekly limits, overtime** | ✓ | ✗ | **Adopt — Stage 3** (limits warn and stop tracking with notice) |
| **Idle timeout with keep/discard on return** | ✓ | Idle is measured, not reviewable by employee | **Adapt** — employee decides on return; agent prompt |
| **Reminders** (forgot to start/stop) | ✓ | ✗ | **Adopt** — agent notifications, employee-controlled |
| **Pay rates, bill rates** | ✓ | ✗ | **Adopt — Stage 3** |
| **Project budgets** (hours or cost, alerts, stop at budget) | Grow+ | ✗ | **Adopt — Stage 3** (alerts; "stop at budget" blocks new sessions on that project, never mid-session) |
| **Clients & invoices** from tracked time | ✓ | ✗ | **Adopt — Stage 3** (approved time only; CSV + printable invoice) |
| Payroll payouts (PayPal, Wise, Payoneer, Deel) | ✓ | ✗ | **Adapt** — payroll CSV export from approved timesheets; payout integrations later |
| **Schedules / shifts, attendance** (late, absent, early leave) | ✓ | ✗ | **Adopt — Stage 3** (employees see their own attendance first) |
| **Time off** (policies, accruals, requests, approvals, holidays) | Team+ | ✗ | **Adopt — Stage 3** |
| App/URL productivity ratings | ✓ | ✗ | **Adapt** — "work apps" categories per team (ACT-07); shown as context, never as a score |
| **Insights: focus time** | Add-on | ✗ | **Adopt — Stage 3**, visible to the employee first |
| **Insights: work-life balance** (after-hours, long days, breakless work) | Add-on | ✗ | **Adopt — Stage 3**, framed as workload, team views aggregate-only (RPT-07) |
| Insights: meetings (Google Calendar) | Add-on | ✗ | Stage 4 (calendar integration) |
| Insights: "unusual activity" / mouse-jiggler detection | Add-on | ✗ | **Decline** — surveillance-first; we show data-quality gaps instead |
| Task/project integrations (Jira, Asana, ClickUp, Trello) | ✓ 30+ | ✗ | Stage 4 (INT-02) — after outbound webhooks |
| Outbound webhooks / API | ✓ | REST API (Pro) | **Adopt — Stage 3** webhooks (INT-03) |
| Mobile apps, GPS, geofencing | ✓ | ✗ | Out of scope (requirements non-goal); revisit for field teams |
| Kanban task tool (Hubstaff Tasks) | Add-on | ✗ | Decline — integrate with existing tools instead |
| SSO / SCIM | Enterprise | Planned | Stage 4 (IAM-06) |

## Stage 3 scope ("Workforce operations")

1. **Timesheets** — weekly timesheet per person built from sessions and approved corrections;
   submit → manager approve/reject with note; approval locks the period (edits need a
   correction against a reopened timesheet); daily/weekly limits with overtime report.
2. **Money** — clients; per-member pay rate and per-project bill rate (effective-dated);
   project budgets (hours or amount, alert thresholds, optional stop-at-budget for new
   sessions); invoices from approved time; payroll CSV per pay period.
3. **Schedules & time off** — recurring shifts per person, attendance status per day
   (on time, late, absent, early leave, on leave), time-off policies with accrual and
   balances, requests and approvals, organization holidays.
4. **Insights** — focus time (≥ 30 min on one project with continuous activity), after-hours
   and weekend work, long days, breakless stretches; employee sees their own; managers see
   team aggregates only when the team has ≥ 5 people; plus team "work app" categories and
   outbound webhooks.
5. **Agent** — idle return prompt (keep / discard / assign to project), start/stop reminders,
   limit warnings.

Plan placement: timesheets and time off are on Standard and Pro (core time records);
budgets, rates, invoices, schedules/attendance, team-level insights and webhooks are Pro;
personal insights are on every plan (privacy and wellbeing are never an upsell).

Implementation streams use separate migrations to avoid collisions: 004 timesheets & limits,
005 rates/budgets/clients/invoices, 006 schedules/attendance/time off, 007 insights,
app categories and webhooks.

## Recon update (2026-10-28)

A `/replica-recon` pass over Hubstaff's 2025–2026 changelog, help center and API docs is in
[`replica/recon.md`](../../replica/recon.md), with the scored matrix in
[`replica/features.csv`](../../replica/features.csv). Track's parity is 62.6/100, with 18 of 19
must-haves done. New since this analysis:

- **Batch approvals** for timesheets, manual time and corrections (Hubstaff 2025 and Q1 2026). Adopt.
- **Utilization targets**: expected hours per person, under- and over-worked. Adapt: show it to the person first, with team views aggregate-only.
- **Average start/stop time and average idle** widgets. Adapt: personal view.
- **Expenses** per project, feeding invoices, and **payroll adjustments** (bonuses, deductions, reimbursements). Adopt.
- **Public API tokens** (personal and organization). Adopt: the Pro plan already lists a REST API.
- **PTO accrual timing** (1st of the month, anniversary, or last day of the month). Could.
- **CLI or MCP server for AI agents** (Hubstaff Sept 2026). Could.
- **AI unusual activity detection**. Decline, as for unusual activity.
- **Remote-vs-office analytics**. Decline: it needs location tracking.
