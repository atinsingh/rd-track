variable "name" {
  description = "Name prefix, e.g. rd-track-staging. Also the cluster name; task families are <name>-<service>."
  type        = string
}

variable "container_insights" {
  description = "ECS Container Insights: disabled, enabled or enhanced (billed per metric)."
  type        = string
  default     = "disabled"
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64. ARM64 (Graviton) is ~20% cheaper but needs arm64 images from CI."
  type        = string
  default     = "X86_64"
}

variable "private_subnet_ids" {
  description = "Subnets the tasks run in."
  type        = list(string)
}

variable "api_security_group_id" {
  description = "Security group for API tasks."
  type        = string
}

variable "web_security_group_id" {
  description = "Security group for web tasks."
  type        = string
}

variable "worker_security_group_id" {
  description = "Security group for worker, migrate and one-off tasks."
  type        = string
}

variable "api_target_group_arn" {
  description = "ALB target group for the API."
  type        = string
}

variable "web_target_group_arn" {
  description = "ALB target group for the web app."
  type        = string
}

variable "api_repository_url" {
  description = "ECR repository for the API image (also runs worker and migrate)."
  type        = string
}

variable "web_repository_url" {
  description = "ECR repository for the web image."
  type        = string
}

variable "initial_image_tag" {
  description = "Tag in the Terraform-registered task definitions. The deploy pipeline registers new revisions with the git SHA; Terraform never rolls services back to this."
  type        = string
  default     = "bootstrap"
}

variable "api_port" {
  description = "API container port."
  type        = number
  default     = 4000
}

variable "web_port" {
  description = "Web container port."
  type        = number
  default     = 3000
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
  description = "Minimum API tasks (≥2 spreads across AZs)."
  type        = number
  default     = 2
}

variable "api_max_count" {
  description = "Maximum API tasks under CPU autoscaling."
  type        = number
  default     = 6
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
  description = "Worker tasks (jobs are claimed with row locks, so more than one is safe)."
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
  description = "Maximum web tasks under CPU autoscaling."
  type        = number
  default     = 4
}

variable "migrate_cpu" {
  description = "Migrate / one-off task CPU units."
  type        = number
  default     = 256
}

variable "migrate_memory" {
  description = "Migrate / one-off task memory (MiB)."
  type        = number
  default     = 512
}

variable "cpu_target_percent" {
  description = "Target average CPU for API and web autoscaling."
  type        = number
  default     = 60
}

variable "log_retention_days" {
  description = "CloudWatch retention for task logs."
  type        = number
}

variable "app_environment" {
  description = "Plain (non-secret) environment for the API, worker and one-off tasks."
  type        = map(string)
}

variable "web_environment" {
  description = "Plain environment for the web app."
  type        = map(string)
  default     = {}
}

variable "secret_arns" {
  description = "Env var name → Secrets Manager ARN. Must contain DATABASE_URL, MIGRATION_DATABASE_URL and APP_DB_PASSWORD; every other entry is given to the API and worker."
  type        = map(string)

  validation {
    condition     = alltrue([for k in ["DATABASE_URL", "MIGRATION_DATABASE_URL", "APP_DB_PASSWORD"] : contains(keys(var.secret_arns), k)])
    error_message = "secret_arns must include DATABASE_URL, MIGRATION_DATABASE_URL and APP_DB_PASSWORD."
  }
}

variable "secrets_kms_key_arn" {
  description = "CMK protecting the secrets (execution role needs kms:Decrypt)."
  type        = string
}

variable "app_db_role" {
  description = "Least-privilege Postgres role the migrate task creates/grants (DATABASE_URL user)."
  type        = string
  default     = "rd_app"
}

variable "bucket_arn" {
  description = "Object bucket the API and worker read and write."
  type        = string
}

variable "bucket_prefixes" {
  description = "Key prefixes the API and worker may touch."
  type        = list(string)
  default     = ["screenshots/", "exports/"]
}

variable "s3_kms_key_arn" {
  description = "CMK of the object bucket."
  type        = string
}

variable "ses_identity_arn" {
  description = "SES identity the API and worker send from (null to grant no email permission)."
  type        = string
  default     = null
}

variable "health_check_grace_period" {
  description = "Seconds ECS ignores ALB health checks after a task starts."
  type        = number
  default     = 60
}
