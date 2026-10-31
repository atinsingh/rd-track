# Brand: the family product (parental controls)

Context: a parental-control product in the space Qustodio is in, built on RoundDigital Track's
engine. Research: `replica/family/recon.md`. Plan: `docs/design/08-family-plan.md`.

**The angle the brand has to carry: transparent parental control.** The child always sees
what the parent sees, nothing is hidden, and no messages are read. It is the family version of
Track's promise that employees see everything their manager can see. Qustodio's weakest
points are reliability, setup spread across four apps, and children's distrust (its Kids App
is rated 1.4★ on Play and 2.2★ on iOS), so the brand should sound calm, honest and
two-sided, not like surveillance.

## 1. Should it carry the Track name? No

Track is sold to employers as "privacy-first, nothing is collected until the employee starts a
session". A parental product monitors by default, and minors cannot opt out. Putting both under
one name blurs the promise that sells Track, and it puts "monitoring software" next to the
workforce brand in app-store and review searches. **Recommendation: a separate product name,
endorsed by the company** ("… by RoundDigital"). The family product shares the engine, the
account system and the trust story, but not the product name.

## 2. The name

Twenty candidates were generated across styles (descriptive, compound, invented, metaphor). The
ones that conflict with an app or product in the same or a nearby category were struck after
a web search on **2026-10-31**:

| Struck | Why (web search, 2026-10-31) |
|---|---|
| Porchlight | porchlightparent.com, a parent content-review tool for kids' apps, the same audience |
| Kinlo | two family apps (a family organizer on the App Store; Kinlo Technologies, Toronto, a family memory app) |
| Tandem | Tandem kids' reading app (App Store) |
| Twofold | Twofold Health, an AI medical scribe on Play |
| Daylit | Daylit planner app; Daylit AI accounts receivable |
| Kinward | Kinward, an app protecting aging parents from scams; kinward.ai, "Your Family's AI Guardian" |
| Kinsee | Kinsee AI, an elder-care companion app on Play |
| Ourglass | Ourglass social app (General Catalyst backed), plus a crypto token |
| Glasshouse | Glasshouse TV dashboard app on Play (weaker conflict, but crowded) |
| Lantern | Lantern, a well-known censorship-circumvention VPN, the very technology category a filter uses |
| Seesaw | Seesaw, a large K-12 classroom app |
| Anything with "Pact", "Custod-", "-dio" | too close to OurPact or to Qustodio |

**Shortlist** (the only check run so far is a web search; everything else is still to run):

| Candidate | Style | Idea | Web search (2026-10-31) | US TM (classes 9, 42) | EU TM | Canada TM | WIPO | .com / .ca | App Store / Play exact name | Handles |
|---|---|---|---|---|---|---|---|---|---|---|
| **RoundDigital Family** | endorsed house brand | the company's own name; safest, least distinctive | no conflict found | to run | to run | to run | to run | n/a (use rounddigital.co/family) | to run | to run |
| **Openkin** | compound | "kin" + "open": the family, in the open | no exact-name hits | to run | to run | to run | to run | to run | to run | to run |
| **Kinlight** | compound | the "lit-up sign" the UK children's code asks for: the family, with a light on | an LED maker (lighting, a different class); a 2026 student design project app | to run | to run | to run | to run | to run | to run | to run |
| **Hearthlight** | metaphor | the light at the family hearth | a kitchen and meal planner app (App Store), a computer-vision company, a game | to run | to run | to run | to run | to run | to run | to run |

**Decided (2026-10-31): Openkin**, as its own app. The original recommendation was to launch as **Openkin by RoundDigital** if the trademark and app-store checks
come back clean. Fall back to **RoundDigital Family**, which needs no new trademark and can
be renamed later at the cost of a migration. Kinlight is a good third choice. Hearthlight
collides with a live App Store app.

These are screening checks, not legal clearance. A trademark lawyer should run a full search
(US, Canada and EU, classes 9 and 42, and 45 for monitoring services) before any money is spent
on the name. Domains and handles: check, then register the same day.

## 3. Palette

Qustodio uses green `#35A777` and violet `#5C5CFF`/`#6161FF` (read from qustodio.com on
2026-10-31). Track uses red `#FD3D41`/`#D42B2B` on ink. The family product takes a **warm lamp
orange**: a different hue family from all three, and it carries the "light on" idea.

| Role | Hex | Use | Contrast (WCAG) |
|---|---|---|---|
| primary | `#B4460C` | buttons, links, key marks on light | 5.49 on white, 5.17 on cream (AA) |
| on-primary | `#FFFFFF` | text on primary buttons | 5.49 (AA) |
| primary-on-dark | `#FFB46B` | links and marks on ink | 11.17 on ink (AA) |
| lamp | `#F5A524` | the "monitoring is on" indicator, highlights; fill only on light | 9.58 on ink (AA) |
| ink | `#0B0C0F` | text, dark surfaces (shared with Track) | 18.41 on cream (AA) |
| surface | `#FFFFFF` | cards | n/a |
| surface-warm | `#FFF7EC` | page background | n/a |
| muted | `#5B6370` | secondary text | 5.71 on cream (AA) |
| info | `#0E7490` | neutral information (never for status alone) | 5.36 on white (AA) |

Status colours (good, warning, critical) are taken from the product's shared design tokens and
always come with an icon and a label. Contrast was computed with the WCAG 2.x formula; there are
zero AA failures. `brand.json` lists Qustodio's colours, so `sweep.py` catches them if they turn
up.

## 4. Logo brief

- **Idea:** a small lit window or lamp inside a rounded house shape. Someone is home, the light
  is on, and you can see in. It ties to "open" or "light" in the name and to the always-visible
  indicator on the child's device.
- **Mark type:** a symbol plus a wordmark; the symbol alone works as the app icon and as the
  child-device status icon (Android requires a unique persistent-notification icon).
- **Must work at:** 16 px (favicon and status-bar notification glyph, single colour) and as a
  1024 × 1024 app icon (iOS: no transparency).
- **Deliverables:** SVG (full colour, one-colour, reversed), a 1024 px app icon, an Android
  adaptive icon (foreground and background), a monochrome notification icon, a favicon set,
  and a 1200 × 630 social image.
- **Must not resemble** Qustodio's mark (put it next to the drafts and check). No shield, eye,
  binoculars, padlock or owl; nothing that reads as surveillance. No green-and-violet pair.

## 5. Voice

**Three words**, each with what it does *not* mean:
- **Honest**, not alarming. Say what is seen and what isn't; no fear marketing.
- **Calm**, not cold. Short sentences and plain words, warm but never cute.
- **Two-sided**, not parent-only. Every screen could be read aloud to the child without
  embarrassment.

| Do | Don't |
|---|---|
| "Maya can see everything you can see." | "Monitor your child's activity in secret." |
| "Screen time is up for today. More after 4 pm." | "BLOCKED! Access denied." |
| "We never read messages." | "Complete visibility into their digital life." |
| "Talk about the rules together, then set them here." | "Take control of your kid's phone." |
| "Maya's phone stopped checking in at 8:40. It may be off or the app was removed." | "ALERT: tampering detected!" |

**The ten most-seen strings, in this voice (EN; FR to follow with the catalogue):**

1. Sign up: "Start your family: free for one child."
2. Main button (parent): "Add a child".
3. Child app first screen: "Your parent set up this app. Here's exactly what they can see."
4. Child status line: "On. Your parent can see app time and location, never your messages."
5. Empty state (parent dashboard): "No devices yet. Add Maya's phone or computer to see today here."
6. Limit reached (child): "That's today's screen time. It's back at 4 pm tomorrow, or ask for more."
7. Ask for more (child): "Ask for 15 more minutes".
8. Confirmation (parent): "Saved. Maya's devices will use the new rules within a minute."
9. Tamper alert (parent): "Maya's phone stopped checking in. It may be off, or the app was removed."
10. Error: "That didn't work. Nothing changed. Try again in a moment."

## 6. Sweep

`python3 /root/.claude/skills/replica-brand/sweep.py . --config replica/family/brand.json`
on 2026-10-31 finds 3 hits, all in `docs/design/08-family-plan.md`, the internal plan that
compares against Qustodio on purpose (as `05-competitive-gap-analysis.md` does for Hubstaff).
The product code, strings and assets are clean. The sweep skips `replica/`, where the recon
names it too. Re-run it before any family screen ships; only the plan document may name the
competitor.

Next: `/replica-launch` (landing page, pricing against Qustodio's $59.95 and $104.95 a year,
and store listings), once the name checks are in.
