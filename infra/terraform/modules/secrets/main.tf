# Application secrets, injected into ECS tasks through `secrets` (never plain env).
#
#   DATABASE_URL           managed: rd_app role (no superuser, no BYPASSRLS) → api, worker
#   MIGRATION_DATABASE_URL managed: schema owner (RDS master user) → migrate task only
#   APP_DB_PASSWORD        managed: rd_app password, which the migrate task applies
#   APP_ENCRYPTION_KEY     operator-provided: 32 random bytes, base64
#   POLICY_SIGNING_KEY_PEM operator-provided: Ed25519 private key PEM
#   STRIPE_SECRET_KEY      operator-provided (placeholder until billing goes live)
#   STRIPE_WEBHOOK_SECRET  operator-provided (placeholder until billing goes live)
#
# Operator-provided secrets start as the literal REPLACE_ME, and Terraform ignores
# their value afterwards so key material never enters Terraform state. The API refuses
# to boot with a placeholder APP_ENCRYPTION_KEY / POLICY_SIGNING_KEY_PEM, so a missed
# step fails loudly. See docs/runbooks/deploy.md "Fill the secrets".

locals {
  operator_secrets = {
    APP_ENCRYPTION_KEY     = "AES-256-GCM key for TOTP secrets at rest (32 bytes, base64)"
    POLICY_SIGNING_KEY_PEM = "Ed25519 private key (PEM) that signs agent policies"
    STRIPE_SECRET_KEY      = "Stripe secret API key"
    STRIPE_WEBHOOK_SECRET  = "Stripe webhook signing secret"
  }
}

resource "aws_secretsmanager_secret" "operator" {
  for_each                = local.operator_secrets
  name                    = "${var.name}/${each.key}"
  description             = each.value
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "operator" {
  for_each      = local.operator_secrets
  secret_id     = aws_secretsmanager_secret.operator[each.key].id
  secret_string = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

locals {
  managed_secrets = {
    DATABASE_URL           = { value = var.database_url, description = "PostgreSQL URL for the API and worker (rd_app role, subject to RLS)" }
    MIGRATION_DATABASE_URL = { value = var.migration_database_url, description = "PostgreSQL URL of the schema owner; migrate task only" }
    APP_DB_PASSWORD        = { value = var.app_db_password, description = "Password of the rd_app role; set by the migrate task" }
  }
}

resource "aws_secretsmanager_secret" "managed" {
  for_each                = local.managed_secrets
  name                    = "${var.name}/${each.key}"
  description             = each.value.description
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "managed" {
  for_each      = local.managed_secrets
  secret_id     = aws_secretsmanager_secret.managed[each.key].id
  secret_string = each.value.value
}
