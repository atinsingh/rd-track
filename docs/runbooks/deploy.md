# Runbook: AWS deployment

How RoundDigital Track runs on AWS, how to stand an environment up the first time,
how routine deploys and rollbacks work, how to restore the database, and how to rotate
keys. Infrastructure code is in [`infra/terraform`](../../infra/terraform). The pipeline
is [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml).

## 0. What runs where

| | staging | production |
|---|---|---|
| AWS account | its own | its own |
| Region | `ca-central-1` (3 AZs) | `ca-central-1` (3 AZs) |
| Terraform root | `infra/terraform/envs/staging` | `infra/terraform/envs/production` |
| Name prefix / ECS cluster | `rd-track-staging` | `rd-track-production` |
| Deployed by | every push to `main` once CI has passed | tag `v*`, after a reviewer approves |

```
internet ──443──► ALB (ACM cert, HTTP→HTTPS, HSTS)
                   ├─ /v1/*  /platform/*  /healthz ──► ECS service "api"    (rd-track-api image, :4000, 2+ tasks, CPU autoscaling)
                   └─ everything else ─────────────► ECS service "web"    (rd-track-web image, :3000, 2+ tasks)
                                                     ECS service "worker" (rd-track-api image, node dist/worker.js, 1+ task)
                                                     one-off task "migrate" (rd-track-api image, run by the pipeline)
private subnets ──5432──► RDS PostgreSQL 16 (isolated subnets, CMK, TLS forced)
                ──S3 gateway endpoint──► objects bucket (screenshots/, exports/; SSE-KMS)
                ──interface endpoints──► ECR, Secrets Manager, CloudWatch Logs
                ──NAT──► SES, Stripe
```

Web and API share one host, so the session cookie stays first-party (`SameSite=Strict`).
The ALB sends `/v1/*` straight to the API; the web app's own `/v1` rewrite is only a
fallback. **HSTS** is added by the ALB to every HTTPS response
(`routing_http_response_strict_transport_security_header_value`, ALB response-header
modification). The web app should also send it so it survives a move off the ALB
(follow-up in §7).

**Database roles.** Row-level security (migration 003) is bypassed by superusers and
`BYPASSRLS` roles, so the services never connect as a privileged role:

| Secret | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `rd_app`: login only, owns nothing, no `BYPASSRLS`; DML on all tables, sequences, functions in `public` | api, worker, one-off admin tasks |
| `MIGRATION_DATABASE_URL` | `rdtrack`: RDS master user, owns the schema (not a superuser on RDS) | migrate task only, injected there as `DATABASE_URL` |
| `APP_DB_PASSWORD` | the `rd_app` password | migrate task only |

The **migrate task** runs three steps and fails the deploy if any fails:
1. ensure `rd_app` (create if missing, set the password from `APP_DB_PASSWORD`, grant,
   `ALTER DEFAULT PRIVILEGES` so future tables are covered),
2. `node dist/db/migrate-cli.js`,
3. step 1 again, so grants cover objects the migrations just created.

It also refuses to continue if `rd_app` is ever `SUPERUSER`/`BYPASSRLS` or owns a table.
The script is [`infra/terraform/modules/ecs/db-role.mjs`](../../infra/terraform/modules/ecs/db-role.mjs).
FORCE RLS also applies to the owner, so a migration that reads or writes tenant rows
must `SET rd.org_id` itself.

## 1. First-time bootstrap (once per environment)

### 1.0 A brand-new AWS account, on credits

Only the account owner can do this part: AWS needs a card, a phone number and identity
checks.

1. **Create the account** at aws.amazon.com with a team mailbox (e.g. `aws-staging@…`),
   not a person's address. Pick the **Paid** plan, or upgrade to it before step 4:
   Activate requires it, and Free-plan credits carry over when you upgrade. Don't join
   it to an AWS Organization or Control Tower yet: that ends the sign-up credits at once.
2. **Lock down root:** hardware or app MFA on the root user, no root access keys, then
   sign in as root only for billing and account settings.
3. **An admin to work as:** IAM Identity Center (or, for a single account, an IAM user
   with MFA) with `AdministratorAccess`; configure it as the `AWS_PROFILE` used below.
4. **Credits:**
   * Sign-up credits: USD 100 on a new account, plus up to USD 100 more for completing
     the activities listed in the console (Billing › Credits).
   * **AWS Activate Founders** (aws.amazon.com/activate): for self-funded companies that
     have a company website, were founded in the last 10 years and have an account on
     the Paid plan. It starts at USD 1,000, and selected startups get up to USD 5,000.
     Apply with the company's domain email and website.
   * **Activate Portfolio** (up to USD 100–200k) needs a code from an accelerator, VC
     or incubator that is an Activate provider; ask any you work with.
   * Check the current terms on AWS's pages before applying: amounts and rules change.
5. **Guard the spend:** in Billing › Budgets, a monthly cost budget with alerts at 50%,
   80% and 100%, emailed to the team. Turn on Cost Explorer and, under Billing
   preferences, *receive Free Tier usage alerts*.
6. **Region:** `ca-central-1` (as everywhere in this runbook).

**What staging costs** (USD per month, `ca-central-1`, rough on-demand estimates before
credits; check with the AWS Pricing Calculator):

| | default staging | `lean = true` |
|---|---|---|
| Fargate tasks | 5 × 0.5 vCPU / 1 GB ≈ 100 | API 0.5/1 GB + web and worker 0.25/0.5 GB ≈ 40 |
| Interface VPC endpoints | 4 services × 3 AZs ≈ 95 | none (through NAT) |
| NAT gateway | ≈ 35 + data | ≈ 35 + data |
| Load balancer | ≈ 20–25 | ≈ 20–25 |
| RDS PostgreSQL | db.t4g.small, 20 GB ≈ 30 | db.t4g.micro, 20 GB ≈ 15 |
| Public IPv4, KMS, Secrets Manager, logs, S3, SES | ≈ 20 | ≈ 15 |
| **Total** | **≈ 300** | **≈ 130** |

`lean = true` in `envs/staging/terraform.tfvars` is meant for an account running on
credits: two AZs, no interface endpoints, one API and one web task, smaller web and
worker tasks, and `db.t4g.micro`. It has no redundancy (a task or AZ failure is an
outage until ECS replaces it), which is fine for testing and demos, not for customers.
On sign-up credits alone (USD 200) a lean staging runs about six weeks; Activate Founders
covers it for many months. To stop paying between test rounds, scale the services to
zero and stop the database (`aws rds stop-db-instance`, which restarts by itself after
seven days); the NAT gateway and load balancer still cost about USD 2 a day.

Do staging end to end first, then production. You need admin access to the target
account (SSO), Terraform ≥ 1.6, AWS CLI v2, `openssl` and `jq`.

### 1.1 State bucket

One bucket per account, created by hand. The state contains the database passwords,
so only the people who run Terraform should be able to read it.

```bash
export AWS_PROFILE=rd-staging            # or rd-production
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET=rd-track-tfstate-$ACCOUNT
aws s3api create-bucket --bucket $BUCKET --region ca-central-1 \
  --create-bucket-configuration LocationConstraint=ca-central-1
aws s3api put-bucket-versioning --bucket $BUCKET --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket $BUCKET --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"},"BucketKeyEnabled":true}]}'
aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Uncomment the `backend "s3"` block in `envs/<env>/versions.tf` and fill in the bucket.
`use_lockfile = true` needs Terraform ≥ 1.10. On older versions, create a DynamoDB
table with partition key `LockID` and use `dynamodb_table` instead.

### 1.2 Variables

```bash
cd infra/terraform/envs/staging
cp terraform.tfvars.example terraform.tfvars   # git-ignored
$EDITOR terraform.tfvars                         # account id, domain, SES domain, alarm emails
terraform init
```

Set `route53_zone_id` if the domain's hosted zone is in this account. Terraform then
creates the ACM validation record, the app alias record and the SES records itself.
Leave it unset to manage DNS somewhere else (§1.4).

### 1.3 Apply order

**DNS in Route 53 (`route53_zone_id` set):** run one `terraform apply`. It waits for the
certificate to be issued.

**DNS elsewhere:** the HTTPS listener needs an issued certificate, so apply in two passes:

```bash
terraform apply \
  -target=module.stack.module.load_balancer.aws_acm_certificate.this \
  -target=module.stack.module.email
terraform output acm_validation_records    # create these CNAMEs now
terraform output ses_dns_records           # and these (DKIM ×3, MAIL FROM MX + TXT, DMARC)
terraform apply                            # waits (≤2 h) until ACM says ISSUED
terraform output alb_dns_name              # point app_domain at it (CNAME / ALIAS)
```

The first full apply takes about 20–40 minutes, mostly RDS (Multi-AZ in production).
**Expect the ECS services to show failing tasks until the first deploy** (§1.7): the
Terraform-registered task definitions point at image tag `bootstrap`, which doesn't exist.
The deployment circuit breaker stops retrying. The first pipeline run replaces them.

### 1.4 DNS records (when not using Route 53)

| Record | Type | Value | From |
|---|---|---|---|
| `<app_domain>` | ALIAS/CNAME | ALB DNS name | `terraform output alb_dns_name` |
| ACM validation | CNAME | as output | `terraform output acm_validation_records` (keep it forever, it is what lets ACM auto-renew) |
| `<token>._domainkey.<ses_domain>` ×3 | CNAME | `<token>.dkim.amazonses.com` | `terraform output ses_dns_records` |
| `mail.<ses_domain>` | MX | `10 feedback-smtp.ca-central-1.amazonses.com` | 〃 |
| `mail.<ses_domain>` | TXT | `v=spf1 include:amazonses.com ~all` | 〃 |
| `_dmarc.<ses_domain>` | TXT | recommendation `v=DMARC1; p=quarantine; adkim=s; aspf=r` (agree on the policy with whoever owns the domain's mail) | 〃 |

### 1.5 Fill the secrets

Terraform creates every secret. It writes the three database secrets itself; the rest
start as `REPLACE_ME`, and Terraform never reads them back (key material stays out of
state). The API refuses to start with a placeholder key, so a missed step fails loudly.

```bash
P=rd-track-staging     # name prefix
umask 077; T=$(mktemp -d)

# AES-256-GCM key for TOTP secrets at rest.
openssl rand -base64 32 | tr -d '\n' > $T/app.key
aws secretsmanager put-secret-value --secret-id $P/APP_ENCRYPTION_KEY --secret-string file://$T/app.key

# Ed25519 policy-signing key. Agents pin its key id (POLICY_SIGNING_KEY_ID, default
# "<env>-1") and public key at enrollment. See §6 before ever changing it.
openssl genpkey -algorithm ed25519 -out $T/policy.pem
aws secretsmanager put-secret-value --secret-id $P/POLICY_SIGNING_KEY_PEM --secret-string file://$T/policy.pem

# Stripe: leave REPLACE_ME while billing_provider = "manual".
# aws secretsmanager put-secret-value --secret-id $P/STRIPE_SECRET_KEY     --secret-string 'sk_live_…'
# aws secretsmanager put-secret-value --secret-id $P/STRIPE_WEBHOOK_SECRET --secret-string 'whsec_…'

# Escrow APP_ENCRYPTION_KEY and the signing key in the break-glass vault: losing the
# first makes every TOTP enrolment unreadable, losing the second strands every agent.
shred -u $T/*; rmdir $T
```

`terraform output secret_names` lists them all.

### 1.6 SES

```bash
aws sesv2 get-email-identity --email-identity <ses_domain> \
  --query '{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus}'
```

Wait for `verified: true`, `dkim: SUCCESS` and `mailFrom: SUCCESS`. A new account is in the
**SES sandbox**, where it can only send to verified addresses. Request production access
once per account:

```bash
aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL \
  --website-url https://<app_domain> --contact-language EN \
  --use-case-description "Transactional email for a B2B SaaS: sign-up verification, password reset, admin notifications. No marketing. Bounces/complaints are suppressed via a configuration set."
```

Staging can stay in the sandbox. Verify the testers' addresses with
`aws sesv2 create-email-identity --email-identity tester@…`.

### 1.7 GitHub environments and the first deploy

In the repository settings → Environments:

| Environment | Protection | Deployment refs |
|---|---|---|
| `staging` | none | branch `main` |
| `production` | required reviewers (≥1, prevent self-review) | tags `v*` |

Set these **variables** on each environment, from `terraform output github_environment_variables`:
`AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, `NAME_PREFIX`, `APP_HOST`. No secrets are needed:
the role trusts only `repo:atinsingh/rd-track:environment:<env>` through GitHub OIDC.

First deploy: Actions → **Deploy** → *Run workflow* → `staging` on `main`. (For
production: push a `v*` tag, then approve.) The run builds both images, runs
`migrate` (this is what creates `rd_app` the first time), rolls the services and checks
`https://<app_domain>/healthz`. In the migrate output, look for
`{"msg":"app db role ready","role":"rd_app"}` twice and the applied migrations between them.

If the role step fails with *"rd_app exists but this user may not alter it"*, someone
created `rd_app` by hand as a different user. As that user, run
`GRANT rd_app TO rdtrack WITH ADMIN OPTION` (or drop the role), then re-run the deploy.

<details><summary>Equivalent SQL, if the role ever has to be created by hand (as the owner)</summary>

```sql
CREATE ROLE rd_app LOGIN PASSWORD '<APP_DB_PASSWORD secret>';   -- defaults: NOSUPERUSER NOBYPASSRLS
GRANT CONNECT ON DATABASE rd_track TO rd_app;
GRANT USAGE ON SCHEMA public TO rd_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rd_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rd_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO rd_app;
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'rd_app';  -- both must be false
```
</details>

### 1.8 First platform operator

`pnpm --filter @rd/api platform:create-admin` runs the TypeScript source through `tsx`.
Neither is in the production image. The image needs a bundled entry point,
`dist/cli/create-platform-admin.js` (add `src/cli/create-platform-admin.ts` to the
esbuild entry points in `apps/api/package.json`). With that in place, run it once as a
one-off task from the worker task definition, which connects as `rd_app`:

```bash
C=rd-track-production
NET=$(aws ecs describe-services --cluster $C --services worker --query 'services[0].networkConfiguration' --output json)
TASK=$(aws ecs run-task --cluster $C --launch-type FARGATE --task-definition $C-worker \
  --network-configuration "$NET" --started-by bootstrap-operator \
  --overrides '{"containerOverrides":[{"name":"worker","command":["node","dist/cli/create-platform-admin.js","ops@rounddigital.example","Ops Name"]}]}' \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster $C --tasks $TASK
STREAM=worker/worker/${TASK##*/}
aws logs get-log-events --log-group-name /ecs/$C/worker --log-stream-name $STREAM --query 'events[].message' --output text
```

The output holds a one-time password and the TOTP secret. Add the secret to the
operator's authenticator and hand over the password out of band. Then **delete the
log stream** so the credentials don't stay in CloudWatch:

```bash
aws logs delete-log-stream --log-group-name /ecs/$C/worker --log-stream-name $STREAM
```

## 2. Routine deploy

* **Staging:** merge to `main`. CI runs, and Deploy starts when it passes.
* **Production:** `git tag -a v1.4.0 -m "…" <sha-on-main> && git push origin v1.4.0`, then
  approve the waiting run in GitHub.

What the pipeline does, and where it stops:

1. Builds `rd-track-api:<sha>` and `rd-track-web:<sha>` and pushes them to the
   environment's ECR. Tags are immutable, so an image that already exists is reused.
   The web image bakes `API_URL=https://<APP_HOST>`.
2. For each family (`api`, `worker`, `web`, `migrate`), copies the latest revision,
   swaps the image and registers a new revision.
3. Runs `migrate` and waits. A non-zero exit fails the deploy, with the services untouched.
4. Updates `api`, `worker` and `web`, then waits until each primary deployment is
   `COMPLETED` on the new revision. A circuit-breaker rollback fails the run.
5. Smoke check: `GET /healthz` → `{"ok":true}`, `GET /login` → 200, HSTS present.

**Migrations run while the previous version is still serving**, and stay in place if
the rollout is rolled back. Every migration must be backward compatible with the
running release (expand → deploy → contract in a later release). Never drop or rename
in the same release that stops using a column.

**Infrastructure/config changes** (env vars, sizes, secrets wiring) go through
`terraform apply`. That registers a new task-definition revision, which the services
deliberately ignore. It takes effect at the next deploy. To apply it now, re-run Deploy
for the current SHA (no rebuild).

**Secret value changes** (`put-secret-value`) are read when a task starts:

```bash
for s in api worker; do aws ecs update-service --cluster $C --service $s --force-new-deployment >/dev/null; done
aws ecs wait services-stable --cluster $C --services api worker
```

## 3. Rollback

* **Automatic:** a deployment whose tasks don't become healthy is rolled back by the
  ECS circuit breaker, and the pipeline fails.
* **To the previous task definition** (fastest, no build):

  ```bash
  C=rd-track-production
  for s in api worker web; do
    aws ecs list-task-definitions --family-prefix $C-$s --sort DESC --max-items 3 --query 'taskDefinitionArns' --output text
  done
  # pick the revision before the bad one for each service:
  aws ecs update-service --cluster $C --service api    --task-definition $C-api:41
  aws ecs update-service --cluster $C --service worker --task-definition $C-worker:38
  aws ecs update-service --cluster $C --service web    --task-definition $C-web:40
  aws ecs wait services-stable --cluster $C --services api worker web
  curl -fsS https://<app_domain>/healthz
  ```

  ECR keeps the last 30 images per repository, which bounds how far back this reaches.
* **Through the pipeline:** Run workflow → `production` using the *previous tag* as the
  ref. It reuses the existing images, re-runs `migrate` (a no-op) and rolls.
* **Schema:** migrations are forward-only. Rolling code back relies on expand/contract
  (§2). If a migration itself is wrong, ship a new forward migration. Restoring the
  database (§4) is the last resort, because it loses writes after the restore point.

## 4. Database restore (and quarterly drill)

Targets (requirements §12): **RPO ≤ 15 min**, **RTO ≤ 4 h**. Automated backups plus
transaction logs give point-in-time restore to within about 5 minutes
(`LatestRestorableTime`). The window is 14 days in production and 3 in staging. A
restore always creates a **new** instance, which is then swapped in under the original
identifier. The endpoint hostname, and with it the `DATABASE_URL` secrets and Terraform
state, then stay valid.

### 4.1 Restore

```bash
C=rd-track-production; DB=$C-db; NEW=$DB-restore-$(date +%Y%m%d%H%M)
aws rds describe-db-instances --db-instance-identifier $DB \
  --query 'DBInstances[0].{latest:LatestRestorableTime,sg:VpcSecurityGroups[0].VpcSecurityGroupId,pg:DBParameterGroups[0].DBParameterGroupName,kms:KmsKeyId,class:DBInstanceClass}'

# 1. Stop writes (api to 0 also stops agent ingestion; agents buffer and retry).
aws application-autoscaling register-scalable-target --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount --resource-id service/$C/api --min-capacity 0
for s in api worker; do aws ecs update-service --cluster $C --service $s --desired-count 0 >/dev/null; done

# 2. Restore to the chosen time (UTC, at or before LatestRestorableTime).
aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier $DB \
  --target-db-instance-identifier $NEW --restore-time 2026-11-03T14:05:00Z \
  --db-subnet-group-name $DB --vpc-security-group-ids <sg> --db-parameter-group-name <pg> \
  --db-instance-class <class> --multi-az --storage-type gp3 --no-publicly-accessible \
  --copy-tags-to-snapshot --deletion-protection
aws rds wait db-instance-available --db-instance-identifier $NEW      # the long step

# 3. Swap identifiers so the hostname in the secrets points at the restored data.
aws rds modify-db-instance --db-instance-identifier $DB  --new-db-instance-identifier $DB-old --apply-immediately
aws rds wait db-instance-available --db-instance-identifier $DB-old
aws rds modify-db-instance --db-instance-identifier $NEW --new-db-instance-identifier $DB --apply-immediately
aws rds wait db-instance-available --db-instance-identifier $DB

# 4. Bring the services back and check.
aws ecs update-service --cluster $C --service worker --desired-count 1 --force-new-deployment >/dev/null
aws ecs update-service --cluster $C --service api --desired-count 2 --force-new-deployment >/dev/null
aws application-autoscaling register-scalable-target --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount --resource-id service/$C/api --min-capacity 2
aws ecs wait services-stable --cluster $C --services api worker
curl -fsS https://<app_domain>/healthz

# 5. Reconcile: `terraform plan` in envs/production should show at most minor drift
#    (Performance Insights, monitoring role, log exports); apply it. Keep $DB-old (deletion protection on)
#    until the incident review is done, then disable protection and delete it.
```

The master password is preserved by the restore, so both connection strings still work.
Objects are not versioned, so the bucket can't be rolled back. Rows restored for
screenshots/exports deleted since the restore point will point at missing objects.
Retention and verification jobs treat those as gone.

### 4.2 Drill (quarterly, staging; yearly against a production snapshot into staging)

1. Note the time. Write a marker row in staging (e.g. create an org named `drill-<date>`).
2. Wait 10 minutes, then run §4.1 with a restore time just after the marker.
3. Record: time to `available` (step 2), total time to a healthy `/healthz` (RTO), and
   the gap between the requested restore time and the newest data present (RPO). Check
   that the marker exists and that row counts of the large tables
   (`activity_buckets`, `ingest_events`, `audit_logs`) look right.
4. File the numbers in the drill log. Act if RTO approaches 4 h (larger instance class
   for the restore, or snapshot-based restore with a smaller log replay window).

Not covered yet: a regional outage. Backups live in `ca-central-1` only (follow-up §7:
AWS Backup cross-region/cross-account copy).

## 5. Observability

* Logs: CloudWatch `/ecs/<prefix>/{api,worker,web,migrate}` (30 days staging, 90 days
  production), RDS `postgresql`/`upgrade` logs, VPC flow logs (production), ALB and S3
  access logs in `<prefix>-logs-<account>-<region>`.
* Alarms → SNS (`terraform output alarm_topic_arn`; email subscriptions must be
  confirmed): ALB 5xx rate > 5 %, API p95 > 1.5 s, RDS CPU > 80 %, RDS free storage
  < 20 % of the initial allocation, worker running count 0 for 5 minutes.
* Performance Insights is on (7 days, free tier). Production adds Container Insights
  and Enhanced Monitoring (60 s).

## 6. Key and credential rotation

| What | How | Notes |
|---|---|---|
| KMS CMKs (RDS, S3, secrets) | automatic, yearly | Old key material stays usable; nothing to do. |
| ACM certificate | automatic renewal | Keep the validation CNAME. |
| SES DKIM | Easy DKIM rotates automatically | |
| GitHub → AWS | OIDC, no stored keys | |
| `rd_app` password | `terraform apply -replace=module.stack.module.database.random_password.app`, then run Deploy | Terraform updates `DATABASE_URL`/`APP_DB_PASSWORD`. The migrate step applies the new password, then the services restart with it. Between those two steps, *new* connections from old tasks fail for a minute or two. Do it off-peak. |
| Master password | `terraform apply -replace=module.stack.module.database.random_password.master` | Updates RDS and `MIGRATION_DATABASE_URL` together. Only the migrate task uses it. |
| Stripe keys | roll in the Stripe dashboard (keep the old webhook secret valid during the overlap), `put-secret-value`, force a new deployment (§2) | |
| `APP_ENCRYPTION_KEY` | **do not rotate** | The API has a single key and no re-encryption. Replacing it makes every stored TOTP secret undecryptable, so every MFA user must re-enroll. Follow-up: key ring with key ids plus a re-encryption job. |
| `POLICY_SIGNING_KEY_PEM` | **do not rotate without app support** | Agents pin `key_id` and the public key at enrollment, so a new key breaks policy verification on every enrolled device. A safe rotation needs a dual-key period: the server announces the next key (signed by the current one), agents accept both, then the old key is retired. Until that exists (follow-up), rotate only on compromise, which means re-enrolling all devices. |

## 7. Follow-ups / known gaps

* `apps/web/next.config.ts` should send `Strict-Transport-Security` itself, as defence in
  depth with the ALB. (`output: 'standalone'`, bundling `create-platform-admin` and
  trusting only the ALB's hop in `X-Forwarded-For` are done.)
* Policy signing key dual-key rotation and `APP_ENCRYPTION_KEY` key ring (§6).
* Cross-region/cross-account backup copies (AWS Backup) for regional DR.
* AWS WAF on the ALB (rate-based rule on `/v1/auth/*`, AWS managed common rules).
* `readonlyRootFilesystem` for api/worker once it's confirmed they write nothing outside `/tmp`.
* Move the `rd_app` grant script into the API codebase (e.g. `src/db/app-role.ts`) so
  its tests run with the rest of the migrations.
