# Stage 4 scope — "Close the gaps, raise the bar"

Status: proposed · 2026-10-28 · Inputs: `replica/recon.md`, `replica/features.csv` (parity 62.6/100,
must-haves 18/19), `05-competitive-gap-analysis.md`, `03-commercial-model.md`.

Stage 3 made Track a full workforce product. Stage 4 does two things:

1. **Closes the gaps that buyers compare on.** These are features Hubstaff has that we decided to adopt or adapt.
2. **Raises the design to best in class.** The product grew from 11 screens to about 30, and its navigation, density and approval flows need to scale with it.

Privacy rules are unchanged:
- The employee sees their own data first.
- Team views are aggregates for groups of 5 or more.
- Nothing is collected silently.
- Computer activity is never a score.

## 1. Feature scope

| # | Feature | Plan | Why | Acceptance |
|---|---|---|---|---|
| F1 | **Idle return prompt**: keep, discard or assign idle time when the person comes back | All | Only missing must-have; buyers expect it | Agent shows the prompt after the idle timeout ends; the choice applies to exactly that span; it survives the agent restarting or going offline (the decision is queued in the outbox); policy setting `idle.prompt_on_return` (default on; off = keep without asking); the employee can never be forced to discard; moving to another project creates a correction, approved first where the organisation reviews corrections and applied directly otherwise; runs over 12 h arrive as consecutive decisions; an edge minute loses only the span's part of its idle seconds |
| F2 | **Batch approvals**: timesheets, manual time / corrections, time off | Standard+ | Approving one at a time doesn't scale past ~10 reports | Filter by person, team, week and type; select-all within the filter; approve, or send back with one note; your own items can never be selected; partial failures are listed per item; one audit entry per item |
| F3 | **Reminders**: start, stop and "still tracking?" | All | Cuts missed time and corrections | Employee-controlled in the agent (on by default, can be switched off); org default times come from schedules when set; never shown while paused or outside working hours |
| F4 | **Limit warnings in the agent** | Standard+ | Limits exist but the agent can't see them | Banner at 80% and 100% of the daily and weekly limits; device-authenticated `GET /v1/device/work-limits`; never stops a running session (consistent with budgets) |
| F5 | **API tokens**: organization and personal | Pro | The Pro plan already sells "REST API" | Admin creates org tokens with `read` / `write` scopes (pay rates only with a separate `payroll` scope), expiring in ≤ 1 year; personal tokens are read-only, limited to the creator's own data and expire in ≤ 90 days; tokens never expose screenshot contents; shown once, stored hashed; last-used time; revocable; every call audited with the token id; documented at `/v1/docs` |
| F6 | **Expected hours and utilization** | Personal: all (when set) · team: Pro | Managers ask "who is over or under?"; employees ask "am I overdoing it?" | Expected hours come from the schedule, else work limits, else org default; time off and holidays reduce them; the person sees their own % first; team view shows counts and averages only, for 5+ people (like team insights); never coloured red |
| F7 | **Expenses** per project, feeding invoices | Pro | Agencies bill expenses with time | Employee submits amount, currency, date, project, category, note and optional receipt (object storage, signed URLs); goes through the approval queue (F2); approved expenses can be added as invoice lines; payroll export gets a reimbursement column |
| F8 | **Payroll adjustments**: bonus, deduction, reimbursement | Pro | Payroll export is incomplete without them | One-time or every pay period; effective-dated; on the payroll CSV as separate columns; the employee sees their own; amounts left out of audit metadata (as for pay rates) |
| F9 | Could: AI-tools preset for work-app categories, PTO accrual day (1st / anniversary / last), average start/stop/idle on the person's insights, read-only client login for agencies, PDF export of insights | mixed | Cheap polish found in the recon | Each ships behind its own small PR |

Explicitly declined, re-confirmed:
- Unusual or AI-suspicious activity detection.
- Location and remote-vs-office analytics.
- GPS and geofencing.
- A built-in task board.

Payroll payouts (Wise, PayPal …) and calendar or task-tool integrations stay in Stage 5.

## 2. Design scope — best in class

What "best in class" means here, measured on the canvas *RoundDigital Track UI* and then in `apps/web`:

- **Information architecture.** The flat menu (~25 items) becomes five groups: **Me · Team · Money · Admin · Settings**.
  - Each group collapses.
  - Admin-only items sit under *Admin*; integrations, tokens and webhooks sit under *Settings → Developers*.
  - There is a ⌘K command palette for jumping to any person, project or page.
- **One approvals inbox.** Corrections, timesheets, time off and expenses share one queue with type filters and batch actions (F2), instead of four sections on one long page.
- **Density.** Data tables get a compact mode, sticky headers and column-aligned numbers (already mono).
- **Decision banners.** Banners use one pattern (title, one line of why, one action) rather than paragraphs.
- **States drawn, not implied.** Every new screen is designed with its empty, loading, error and "plan doesn't include this" states.
- **The agent as a first-class surface.** The idle prompt, reminders and limit warnings are designed as one family of compact notices next to the existing popover.
- **Accessibility as drawn.**
  - Real controls, with 44 px targets.
  - Text contrast of 4.5:1.
  - Status never shown by colour alone.
  - Reduced motion respected.

### Visual direction: solid glass (decided 2026-10-28)

The canvas's *Design system* artboard is the reference.

- **Glass panels:** frosted panels, `rgba(255,255,255,0.78)` with a 24 px backdrop blur, a white hairline edge and soft shadow. They sit over a backdrop of `#ECEEF2` with two faint light fields, blue and brand red, never more.
- **Dark glass:** the floating navigation and live-state banners are dark glass (`rgba(11,12,15,0.86)`).
- **Radius:** 16 on panels, 10 on controls and menu items, 6 on badges.
- **Muted text:** moves to `#53595F` so it reaches 4.9:1 even on the bare backdrop. All glass text pairs stay ≥ 5.3:1.
- **Unchanged:** type (Inter Tight / Inter / JetBrains Mono), and brand red only as a chrome mark.

### Data palette

Validated with the dataviz checks on white. Adjacent CVD ΔE ≥ 9.1, normal-vision ΔE ≥ 19.6.

- **Categorical, fixed order, never cycled:** blue `#2a78d6`, orange `#eb6834`, aqua `#1baf7a`, yellow `#eda100`, magenta `#e87ba4`, green `#008300`, violet `#6250d6`. "Other" is `#9AA0A8`.
  - There is no red series: brand red never marks a person's data.
  - Slots 3–5 are under 3:1 on white, so charts using them keep their value labels and "View as table".
- **Single-series magnitude:** blue. Part-of-whole (focus inside tracked time) uses the blue ramp `#2a78d6` / `#86b6ef`.
- **Diverging (under ↔ over expected):** blue ↔ orange around grey.
- **Not data:** states (paused, asleep, no permission) stay grey textures, and status stays amber with a label.
- **Labels:** values sit beside marks in text colour, never inside them (white on the series blue is only 4.4:1).

## 3. Build order

1. F1 idle prompt (agent, API, web history)
2. F2 batch approvals + the unified inbox
3. IA / navigation regroup and ⌘K — **done**:
   - five collapsible groups (folded state is remembered per browser; the group holding the current page never folds);
   - a folded Team group still shows the approvals count;
   - ⌘K / Ctrl K palette over pages, the people in teams you manage and your projects (`GET /v1/me/directory`, names only, not audited as a data view);
   - solid glass applied through tokens (`--glass*`, `--ink-glass*`, `--radius-*`).
   - *Settings → Developers* replaces *Webhooks* now that F5 adds tokens to it.
4. F4 + F3 agent notices
5. F5 API tokens — **done 2026-10-29** (migration 018):
   - organization tokens (`rdt_org_…`, org admins, `read` + optional `write` and `payroll`,
     up to a year) and personal tokens (`rdt_pat_…`, anyone, read-only, own data, up to 90
     days); shown once, stored as a hash, last used, revocable by an admin or the owner;
   - a token acts as its creator as they are now (role, status, plan), so it never sees
     more than they could: an admin's token reads someone's hours only for a team the
     admin manages, as in the app;
   - it only works on the endpoints in the API surface (`apps/api/src/modules/api-tokens/surface.ts`),
     which also generates the reference at `/v1/docs` and `/v1/docs/openapi.json`; sign-in,
     passwords and MFA, tokens, single sign-on, support access, closing the organization and
     screenshot images answer `403 not_in_api`;
   - every call is audited (`api.request`, refused ones too), and changes it makes are
     audited as "API token · name" on behalf of the creator; people see token reads of
     their data in "Who viewed your data";
   - owners are told a week before a token expires; Settings › Developers has tabs for API
     tokens, webhooks and the reference; personal tokens are in My account › Settings.
6. F6 expected hours — **done 2026-10-29**:
   - worked out on read, per day: the person's schedule (their shifts and overrides),
     else their work limits (the daily limit, else a fifth of the weekly one, on
     weekdays), else the organization's standard day on weekdays; holidays expect
     nothing and approved time off is taken off (`apps/api/src/modules/insights/expected.ts`);
   - My insights opens with "Tracked vs expected" (the person's own %, a meter with the
     expected mark) and a chart of each day — or each week over 4 weeks — with focus and
     other tracked time against a dashed expected line, and a sentence saying where the
     expectation comes from; the By day table gains an Expected column;
   - team insights (Pro, 5+ people) add the average % and counts of people under, about
     (±10 %) and over expected — counts only, never who;
   - blue for under and the series, orange for over, grey for about; never red.
7. F7 expenses — **done 2026-10-29** (migration 019):
   - My expenses (Pro): amount, currency, date, category, project, a note and an optional
     receipt (photo or PDF up to 10 MB) that the browser uploads straight to private
     storage with a presigned PUT; the API checks it arrived before saving the claim;
   - claims go to the person's team managers (org admins when they have none) as an
     *Expenses* tab in the approvals inbox, batch-approvable like the rest; nobody reviews
     their own; sending back needs a reason, which the claimant is told;
   - the receipt opens for the claimant, their reviewers and finance/admins only, through
     a short-lived link; every view by someone else is in the claimant's access log;
   - on a project with a client, "Bill this to the client" puts the approved expense on
     the client's next draft invoice as its own line, once (`invoice_lines.expense_id`);
   - the payroll file's `reimbursements` column pays approved, unpaid expenses; a file for
     a period marks them paid with that period (making it again includes them again);
   - My expenses shows waiting / to be paid / paid this year, per currency, and each
     claim's status: waiting, approved, paid with a period and on which invoice, sent back
     with the reason, or withdrawn.
8. F8 payroll adjustments — **done 2026-10-29** (migration 020):
   - bonus, deduction or reimbursement for a person, once (in the pay period containing
     its date) or every pay period from a date until an optional end;
   - their own `bonus` and `deductions` columns in the payroll CSV (reimbursements share
     the column with expenses); a person paid in two currencies gets each on the row in
     that currency;
   - set under Money › Rates and budgets beside pay rates; loaded on request, and each
     person shown gets an entry in their access log; amounts never go in the audit log;
   - the person sees their own under My time › My pay; recurring ones are ended, one-time
     ones (and recurring ones not yet started) removed.
9. F9 polish items

After step 4, the build order continues with the engine and role workspaces in
[`07-product-review.md`](07-product-review.md); F5–F9 slot in after its slice 3.

Each step is one PR into `main`. It must pass CI and a browser check of its screens on the demo data before it merges.
