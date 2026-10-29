variable "aws_account_id" {
  description = "AWS account that hosts staging. The provider refuses any other."
  type        = string
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "ca-central-1"
}

variable "app_domain" {
  description = "Public host for the web app and API, e.g. staging.track.rounddigital.example."
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 zone for app_domain and ses_domain in this account; null to create DNS records by hand."
  type        = string
  default     = null
}

variable "vpc_cidr" {
  description = "VPC /16 (keep distinct per environment in case of future peering)."
  type        = string
  default     = "10.20.0.0/16"
}

variable "ses_domain" {
  description = "Domain verified in SES for transactional email."
  type        = string
}

variable "email_from" {
  description = "From header for transactional email; the address must be on ses_domain."
  type        = string
}

variable "policy_signing_key_id" {
  description = "Key id of POLICY_SIGNING_KEY_PEM. Agents pin it at enrollment."
  type        = string
  default     = "staging-1"
}

variable "billing_provider" {
  description = "manual or stripe."
  type        = string
  default     = "manual"
}

variable "stripe_price_standard" {
  description = "Stripe price id for Standard, month to month."
  type        = string
  default     = ""
}

variable "stripe_price_pro" {
  description = "Stripe price id for Pro, month to month."
  type        = string
  default     = ""
}

variable "stripe_price_standard_annual" {
  description = "Stripe price id for Standard on an annual term."
  type        = string
  default     = ""
}

variable "stripe_price_pro_annual" {
  description = "Stripe price id for Pro on an annual term."
  type        = string
  default     = ""
}

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

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC provider (false if this account already has one)."
  type        = bool
  default     = true
}

variable "extra_app_environment" {
  description = "Extra plain env vars for API/worker/migrate."
  type        = map(string)
  default     = {}
}

variable "agent_download_base_url" {
  description = "AGENT_DOWNLOAD_BASE_URL: where agent installers are published, e.g. https://github.com/<org>/<repo>/releases/download/agent-v0.2.0. Empty: the web app says installers aren't published yet."
  type        = string
  default     = ""
}

variable "agent_version" {
  description = "AGENT_VERSION: the published agent version offered for download, e.g. 0.2.0."
  type        = string
  default     = ""
}
