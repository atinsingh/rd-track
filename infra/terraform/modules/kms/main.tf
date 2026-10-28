# One customer-managed key per data class so that grants, audit trails and (if ever
# needed) crypto-shredding can be reasoned about separately. Annual rotation is on;
# AWS keeps old key material so existing ciphertext stays readable.
#
# No explicit key policy: the default policy delegates to IAM in this account, and the
# roles that need a key (ECS execution role → secrets, task roles → S3) get kms:* actions
# scoped to that one key ARN in their own policies. RDS and S3 use the key through
# service grants created on behalf of the caller.

locals {
  keys = {
    rds     = "RDS PostgreSQL storage, snapshots and Performance Insights"
    s3      = "S3 object bucket (screenshots, exports)"
    secrets = "Secrets Manager application secrets"
  }
}

resource "aws_kms_key" "this" {
  for_each                = local.keys
  description             = "${var.name}: ${each.value}"
  enable_key_rotation     = true
  deletion_window_in_days = var.deletion_window_in_days
  tags                    = { Name = "${var.name}-${each.key}", Purpose = each.key }
}

resource "aws_kms_alias" "this" {
  for_each      = local.keys
  name          = "alias/${var.name}-${each.key}"
  target_key_id = aws_kms_key.this[each.key].key_id
}
