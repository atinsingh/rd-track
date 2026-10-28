# RoundDigital Track — UX Design

**Status:** Draft for review · **Date:** 2026-10-28
**Visual mockups:** [RoundDigital Track UI canvas](https://claude.ai/artifact/FyvyFXt9rY4rjiusnKxnAM) —
My day, Team week, Policies, What's collected, Devices, desktop agent. Visual style is
provisional until RoundDigital brand colors, type and logo are applied.

## 1. Principles that shape every screen

1. **Same data, both sides.** Anything a manager can see about an employee, the employee
   can see first, on their own pages, with the same numbers.
2. **"Computer activity", not "productivity".** Activity is a percentage of *measurable*
   session time with device input. Each activity figure has an ⓘ that opens the
   calculation and lists what it can't see (meetings, calls, reading, thinking).
3. **Gaps are not idleness.** Paused, suspended, offline and permission-missing time are
   drawn as their own hatched bands, never as low activity.
4. **No leaderboards.** Team views sort by name by default; there is no rank column, no
   red/green per-person score, no "least active" filter.
5. **Screenshots are visibly exceptional.** Off by default; when on, a camera badge in
   the agent and on the employee's dashboard; every manager view of a screenshot is
   audited and visible to the employee in "Who viewed my data".

## 2. Information architecture

```
Employee                Manager (adds)          Org admin (adds)          Auditor
──────────              ──────────────          ────────────────          ───────
My day      /me         Team        /team       People      /admin/users  Audit log /audit
My time     /me/time    Member      /team/:uid  Teams       /admin/teams
Screenshots /me/screens Approvals   /approvals  Projects    /admin/projects
What's      /me/privacy Projects    /projects   Devices     /admin/devices
 collected                                      Policies    /admin/policies
Exports     /exports                            Deletion    /admin/requests
                                                 requests
```

Navigation is a left rail showing only the sections the signed-in user's roles allow.

## 3. Screens

### 3.1 My day (`/me`) — `RPT-01`

```
┌ My day ─────────────────────────── ◀ Tue 28 Oct 2026 ▶  [Europe/London ▾] ┐
│ Tracked 6h 42m   Computer activity 71% ⓘ   Manual 0h 30m   Gaps 1h 05m     │
├────────────────────────────────────────────────────────────────────────────┤
│ 08 ─── 09 ─── 10 ─── 11 ─── 12 ─── 13 ─── 14 ─── 15 ─── 16 ─── 17 ───     │
│ ▁▃▆▇▇▆▅▃░░░░▇▇▆▅▆▇▇▆▅▂ ▒▒▒▒ ▆▇▇▇▅▃▂▄▆▇▇▇▆▅▄▃                              │
│ █ active  ▒ paused  ░ asleep/offline  ▨ no permission                      │
├──────────────────────────────┬─────────────────────────────────────────────┤
│ Sessions                     │ Applications (time in foreground)           │
│ 08:12–12:01 Client A · Build │ Visual Studio Code   3h 10m ████████       │
│ 13:02–17:15 Internal         │ Chrome               1h 52m █████          │
│ [+ Add manual time]          │ Slack                  48m ██              │
├──────────────────────────────┴─────────────────────────────────────────────┤
│ Screenshots (policy: Client A project, every ~15 min, kept 30 days)        │
│ [thumb][thumb][thumb]…   each: time · app · [Request deletion]             │
└────────────────────────────────────────────────────────────────────────────┘
```

* Timeline: one column per 5 minutes, height = active seconds share. Hover shows the
  minute range, active/idle seconds and data quality.
* The screenshot strip only renders when the employee's resolved policy enables
  screenshots, or screenshots exist in range.

### 3.2 My time (`/me/time`) — `TIME-08`

Table of sessions for a week with project, start, end, tracked, source (`agent`,
`manual`, `corrected`). Row action "Propose correction" opens a side sheet:

```
Propose a correction
  Session     Tue 28 Oct, 08:12 → 12:01, Client A
  New start   [08:00]   New end [12:01]   Project [Client A ▾]
  Reason*     [Forgot to start the timer before the stand-up      ]
  Original values are kept and shown to your manager.   [Cancel] [Submit]
```

Pending, approved and rejected corrections are listed below with the reviewer's note.

### 3.3 What's collected about me (`/me/privacy`)

Generated from `GET /v1/me/policy`, in plain language:

```
While a work session is active, RoundDigital Track records:
  ✓ When your session starts, pauses and stops
  ✓ How many keyboard and mouse events happen each minute — never which keys
  ✓ The name of the app in front (e.g. "Visual Studio Code")
  ✗ Website domains                       ✗ Window titles or full URLs
  ✓ Screenshots on project "Client A": about one every 15 minutes, kept 30 days
Who can see it:  you · your team manager (time, activity, apps) · screenshots: you only
Kept for:        activity 90 days · app usage 90 days · screenshots 30 days
Never recorded:  typed text, passwords, clipboard, webcam, microphone, messages, location
[Who viewed my data]  (audit entries where target = me)
```

### 3.4 Team (`/team`) — `RPT-02`

```
┌ Team: Platform ▾ ───────── This week ▾  [Export CSV] ┐
│ Name ▴        Tracked   Activity ⓘ  Gaps   Manual  Days │
│ Ada Lovelace   36h 10m    68%       2h 05m  0h 30m  5    │
│ Grace Hopper   31h 45m    74%       0h 20m  —       4    │
│ …                                                        │
├──────────────────────────────────────────────────────────┤
│ Daily tracked hours (stacked by project)  ▇▇▆▇▅          │
└──────────────────────────────────────────────────────────┘
```

Clicking a member opens `/team/:uid`, the same layout as "My day" with the member's
data, filtered by what policy lets the manager see; screenshots appear only when policy
grants it, with "Viewing is recorded" above the strip.

### 3.5 Approvals (`/approvals`)

Queue of pending corrections for members of managed teams, showing original vs requested
side by side and the reason; Approve / Reject with an optional note.

### 3.6 Admin — Policies (`/admin/policies`) — `POL-*`

Left: scope tree (Organization → Teams → Projects → Devices). Right: the scope's partial
settings. Every field shows three states — *Not set (inherit)*, *On*, *Off* — and the
**effective** value with "because: Team Platform sets Off".

Publishing shows a diff and, when collection expands, a confirmation:

```
This change increases what is collected for 14 employees:
  • Screenshots: off → every 15 min (project Client A)
Employees will be notified before it takes effect.  Change note* [ … ]
                                                [Cancel] [Publish and notify]
```

### 3.7 Admin — Devices (`/admin/devices`) — `DEV-01`

Columns: user, device name, OS, agent version, enrolled, last seen, last sync, policy
revision applied (with "behind" warning), permission health (input / screen recording),
status, [Revoke]. "New enrollment code" opens a dialog showing the code once with its
expiry countdown.

### 3.8 Audit log (`/audit`)

Filterable table: time, actor, action, target, result, request id. No payloads.

## 4. Desktop agent UI

```
Tray / menu bar:   ● Tracking — Client A · 2h 14m   📷 (only if screenshots on)
Popover:           [Project ▾] [Task ▾]
                   ( Pause )  ( Stop )
                   Today 6h 42m · Activity 71%
                   This session collects: activity counts, app names, screenshots ~15 min
                   Open my dashboard ↗   Sync: up to date (12 s ago)
```

* Session start notice lists what is collected for this project before tracking begins.
* Permission problems show a single, dismissible banner with a "Fix in System Settings"
  link — never a loop of prompts.

## 5. Visual system

* Type: Inter (UI), JetBrains Mono for numbers in tables.
* Color tokens: neutral surfaces; a single accent (`--accent`, teal) for active time;
  hatched neutral for gaps; amber only for warnings (device behind on policy, permission
  missing). Red is reserved for destructive actions — never for a person's activity.
* Accessibility: WCAG 2.2 AA contrast; the timeline has a table alternative; every chart
  has a text summary; all actions keyboard-reachable.
