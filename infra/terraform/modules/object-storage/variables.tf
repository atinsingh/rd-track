variable "name" {
  description = "Name prefix, e.g. rd-track-staging."
  type        = string
}

variable "bucket_name" {
  description = "Override for the object bucket name. Default: <name>-objects-<account>-<region> (globally unique)."
  type        = string
  default     = null
}

variable "kms_key_arn" {
  description = "CMK used for SSE-KMS on the object bucket."
  type        = string
}

variable "cors_allowed_origins" {
  description = "Browser origins allowed to GET/PUT presigned URLs, e.g. [\"https://track.example.com\"]."
  type        = list(string)
}

variable "screenshots_expiration_days" {
  description = "Backstop expiry for screenshots/. The retention worker deletes earlier; this only catches misses. Must exceed the longest plan retention."
  type        = number
  default     = 95
}

variable "exports_expiration_days" {
  description = "Backstop expiry for exports/ (download links expire much sooner)."
  type        = number
  default     = 2
}

variable "logs_expiration_days" {
  description = "Retention of S3 server access logs and ALB access logs in the logs bucket."
  type        = number
  default     = 365
}

variable "alb_log_prefix" {
  description = "Prefix under which the ALB writes access logs in the logs bucket."
  type        = string
  default     = "alb"
}

variable "force_destroy" {
  description = "Allow terraform destroy to delete non-empty buckets. Never true in production."
  type        = bool
  default     = false
}
