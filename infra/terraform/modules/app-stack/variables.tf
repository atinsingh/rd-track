# Everything an environment differs in. Defaults are the staging-sized, cheap choice
# unless noted; envs/production overrides them.

# --- Identity ---------------------------------------------------------------

variable "project" {
  description = "Short project name; prefixes every resource."
  type        = string
  default     = "rd-track"
}

variable "environment" {
  description = "staging or production."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

# --- DNS / TLS --------------------------------------------------------------

variable "app_domain" {
  description = "Public host for web app + API (one origin), e.g. track.rounddigital.example."
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone containing app_domain and ses_domain. Null = manage DNS by hand from the outputs."
  type        = string
  default     = null
}

# --- Network ----------------------------------------------------------------

variable "vpc_cidr" {
  description = "VPC /16."
  type        = string
}

variable "single_nat_gateway" {
  description = "One NAT gateway instead of one per AZ."
  type        = bool
  default     = true
}

variable "enable_flow_logs" {
  description = "VPC flow logs to CloudWatch."
  type        = bool
  default     = false
}

# --- Database ---------------------------------------------------------------

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.small"
}

variable "db_allocated_storage" {
  description = "Initial storage (GiB)."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling (GiB)."
  type        = number
  default     = 100
}

variable "db_multi_az" {
  description = "Multi-AZ standby."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Automated backups / PITR window."
  type        = number
  default     = 3
}

variable "db_deletion_protection" {
  description = "RDS deletion protection."
  type        = bool
  default     = false
}

variable "db_monitoring_interval" {
  description = "Enhanced Monitoring seconds (0 = off)."
  type        = number
  default     = 0
}

# --- Services ---------------------------------------------------------------

variable "container_insights" {
  description = "disabled | enabled | enhanced."
  type        = string
  default     = "disabled"
}

variable "api_cpu" {
  description = "API task CPU units."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "API task memory (MiB)."
  type        = number
  default     = 1024
}

variable "api_min_count" {
  description = "Minimum API tasks."
  type        = number
  default     = 2
}

variable "api_max_count" {
  description = "Maximum API tasks."
  type        = number
  default     = 4
}

variable "worker_cpu" {
  description = "Worker task CPU units."
  type        = number
  default     = 512
}

variable "worker_memory" {
  description = "Worker task memory (MiB)."
  type        = number
  default     = 1024
}

variable "worker_count" {
  description = "Worker tasks."
  type        = number
  default     = 1
}

variable "web_cpu" {
  description = "Web task CPU units."
  type        = number
  default     = 512
}

variable "web_memory" {
  description = "Web task memory (MiB)."
  type        = number
  default     = 1024
}

variable "web_min_count" {
  description = "Minimum web tasks."
  type        = number
  default     = 2
}

variable "web_max_count" {
  description = "Maximum web tasks."
  type        = number
  default     = 4
}

variable "log_retention_days" {
  description = "Application log retention (staging 30, production 90)."
  type        = number
  default     = 30
}

# --- Application configuration (plain env) ---------------------------------

variable "policy_signing_key_id" {
  description = "POLICY_SIGNING_KEY_ID: key id agents pin at enrollment. Change only with a key rotation (runbook)."
  type        = string
}

variable "email_from" {
  description = "EMAIL_FROM, e.g. \"RoundDigital Track <no-reply@track.rounddigital.example>\". Must be on ses_domain."
  type        = string
}

variable "ses_domain" {
  description = "Domain verified in SES."
  type        = string
}

variable "billing_provider" {
  description = "BILLING_PROVIDER: manual or stripe. Fill the Stripe secrets before switching to stripe."
  type        = string
  default     = "manual"
}

variable "stripe_price_standard" {
  description = "STRIPE_PRICE_STANDARD_MONTHLY: Standard, month to month (price id, not secret)."
  type        = string
  default     = ""
}

variable "stripe_price_pro" {
  description = "STRIPE_PRICE_PRO_MONTHLY: Pro, month to month (price id, not secret)."
  type        = string
  default     = ""
}

variable "stripe_price_standard_annual" {
  description = "STRIPE_PRICE_STANDARD_ANNUAL: Standard, annual term (price id, not secret)."
  type        = string
  default     = ""
}

variable "stripe_price_pro_annual" {
  description = "STRIPE_PRICE_PRO_ANNUAL: Pro, annual term (price id, not secret)."
  type        = string
  default     = ""
}

variable "extra_app_environment" {
  description = "Additional/override plain env vars for API, worker and migrate (e.g. SESSION_TTL_HOURS, LOG_LEVEL)."
  type        = map(string)
  default     = {}
}

# --- Monitoring -------------------------------------------------------------

variable "alarm_topic_arn" {
  description = "Existing SNS topic for alarms; null creates one."
  type        = string
  default     = null
}

variable "alarm_emails" {
  description = "Emails subscribed to the created alarm topic."
  type        = list(string)
  default     = []
}

# --- CI/CD ------------------------------------------------------------------

variable "github_repository" {
  description = "Repository allowed to deploy."
  type        = string
  default     = "atinsingh/rd-track"
}

variable "github_environment" {
  description = "GitHub environment name allowed to deploy (defaults to environment)."
  type        = string
  default     = null
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC provider in this account (false if it already exists)."
  type        = bool
  default     = true
}

# --- Safety -----------------------------------------------------------------

variable "protect_resources" {
  description = "Deletion protection on ALB, final RDS snapshot, no force-destroy of buckets/repos, 30-day secret recovery."
  type        = bool
  default     = false
}
