# Stage 2 — Pilot and first paying customers

**Status:** In progress · **Date:** 2026-10-28

Stage 1 delivered the design, API, worker, web dashboard and a simulated-input agent.
Stage 2 makes the product installable on real employee machines, sellable without manual
work, deployable to AWS, and hardened for a security review.

| Stream | Scope | Requirement / doc refs |
|---|---|---|
| **Desktop agent** | Native collectors (Windows: `GetLastInputInfo` + low-level hooks that only count; foreground process; DXGI/GDI capture. macOS: `CGEventSource` counters and idle time, `NSWorkspace` frontmost app, ScreenCaptureKit / `CGWindowListCreateImage`); permission health reporting; Tauri tray app matching the agent mockup (project/task pickers, pause/stop, session-start notice, persistent indicator, camera badge); OS keychain credentials; signed installers (MSI, DMG) and updater config; CI builds on Windows and macOS runners | TIME-02, ACT-01..06, SCR-03..06, DEV-02/03, system design §8 |
| **Commercial** | Stripe billing provider (Checkout for new subscriptions, Customer Portal, per-seat quantity sync, signed webhooks driving subscription state); self-serve signup with email verification starting a 14-day Pro trial; transactional email (dev console, SES in production); web screens for signup, verification, upgrade | Commercial model §2–§7 |
| **Hardening** | Postgres row-level security on every tenant table as defence in depth; contract gaps found during integration (screenshot app name, team report project filter, per-member visibility); security headers and session rotation review | ADR-0004, security §9 |
| **Infrastructure** | Terraform for AWS (VPC, ECS Fargate for API/worker/web, RDS PostgreSQL, private S3 with SSE-KMS and lifecycle, Secrets Manager, ALB + ACM, CloudWatch); web Dockerfile; deploy workflow (build → ECR → migrate → roll services) | Requirements §8, §12 |

**Exit criteria:** an employee on a company Mac or Windows laptop installs a signed agent,
enrolls with a code, and sees the tray indicator; a new company signs up, verifies email,
runs a trial and upgrades through Stripe; the stack deploys to a fresh AWS account with
`terraform apply` and the deploy workflow; a tenant-isolation test suite passes with RLS on.

**Out of scope for Stage 2:** SSO/SCIM (Stage 3), app/domain categories, scheduled and PDF
reports, aggregate-only executive views, reseller accounts.
