# Private object storage (system design §9):
#   * objects bucket — screenshots/ and exports/, SSE-KMS with a CMK, TLS-only,
#     Block Public Access, ACLs disabled, versioning OFF (deletes must really delete:
#     retention and employee deletion requests), lifecycle expiry as a backstop.
#   * logs bucket    — S3 server access logs and ALB access logs. SSE-S3 because
#     neither log delivery service can write to SSE-KMS buckets.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_elb_service_account" "this" {}

locals {
  account_id  = data.aws_caller_identity.current.account_id
  region      = data.aws_region.current.name
  bucket_name = coalesce(var.bucket_name, "${var.name}-objects-${local.account_id}-${local.region}")
  logs_name   = "${var.name}-logs-${local.account_id}-${local.region}"
}

# =============================================================================
# Logs bucket
# =============================================================================

resource "aws_s3_bucket" "logs" {
  bucket        = local.logs_name
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expire-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = var.logs_expiration_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "logs" {
  statement {
    sid       = "S3ServerAccessLogs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/s3-access/*"]
    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.objects.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }

  # Regions launched before Aug 2022 (ca-central-1 included) deliver ALB logs from the
  # regional ELB account; newer regions use the log-delivery service principal.
  statement {
    sid       = "AlbAccessLogsLegacy"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/${var.alb_log_prefix}/AWSLogs/${local.account_id}/*"]
    principals {
      type        = "AWS"
      identifiers = [data.aws_elb_service_account.this.arn]
    }
  }

  statement {
    sid       = "AlbAccessLogs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/${var.alb_log_prefix}/AWSLogs/${local.account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.logs.arn, "${aws_s3_bucket.logs.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = data.aws_iam_policy_document.logs.json

  depends_on = [aws_s3_bucket_public_access_block.logs]
}

# =============================================================================
# Objects bucket
# =============================================================================

resource "aws_s3_bucket" "objects" {
  bucket        = local.bucket_name
  force_destroy = var.force_destroy
}

# Versioning is intentionally not enabled: a deleted screenshot must be gone, not
# kept as a noncurrent version (retention, AUD-04 deletion requests).

resource "aws_s3_bucket_ownership_controls" "objects" {
  bucket = aws_s3_bucket.objects.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "objects" {
  bucket                  = aws_s3_bucket.objects.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "objects" {
  bucket = aws_s3_bucket.objects.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    # S3 Bucket Keys cut KMS request volume (and cost) by ~99% for per-object encryption.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "objects" {
  bucket = aws_s3_bucket.objects.id

  rule {
    id     = "screenshots-backstop"
    status = "Enabled"
    filter {
      prefix = "screenshots/"
    }
    expiration {
      days = var.screenshots_expiration_days
    }
  }

  rule {
    id     = "exports-backstop"
    status = "Enabled"
    filter {
      prefix = "exports/"
    }
    expiration {
      days = var.exports_expiration_days
    }
  }

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# Agents upload with presigned PUTs (no CORS involved). Browsers may fetch presigned
# GET URLs for screenshots/exports from the app origin, and future browser uploads
# (e.g. tenant logos) would PUT. Nothing else is allowed cross-origin.
resource "aws_s3_bucket_cors_configuration" "objects" {
  bucket = aws_s3_bucket.objects.id
  cors_rule {
    allowed_methods = ["GET", "PUT"]
    allowed_origins = var.cors_allowed_origins
    allowed_headers = ["content-type"]
    expose_headers  = ["ETag"]
    max_age_seconds = 300
  }
}

resource "aws_s3_bucket_logging" "objects" {
  bucket        = aws_s3_bucket.objects.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3-access/"

  depends_on = [aws_s3_bucket_policy.logs]
}

data "aws_iam_policy_document" "objects" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.objects.arn, "${aws_s3_bucket.objects.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyOutdatedTls"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.objects.arn, "${aws_s3_bucket.objects.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "NumericLessThan"
      variable = "s3:TlsVersion"
      values   = ["1.2"]
    }
  }

  # Presigned uploads send no encryption headers and get the bucket default (our CMK).
  # A request that does name an encryption mode or key must name ours.
  statement {
    sid       = "DenyOtherEncryption"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.objects.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid       = "DenyOtherKmsKey"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.objects.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [var.kms_key_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "objects" {
  bucket = aws_s3_bucket.objects.id
  policy = data.aws_iam_policy_document.objects.json

  depends_on = [aws_s3_bucket_public_access_block.objects]
}
