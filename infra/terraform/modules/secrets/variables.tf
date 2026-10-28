variable "name" {
  description = "Name prefix, e.g. rd-track-staging. Secrets are named <name>/<ENV_VAR_NAME>."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK that encrypts every secret."
  type        = string
}

variable "database_url" {
  description = "DATABASE_URL for the API and worker: the least-privilege rd_app role (subject to RLS)."
  type        = string
  sensitive   = true
}

variable "migration_database_url" {
  description = "Connection string for the schema owner (RDS master user); used only by the migrate task."
  type        = string
  sensitive   = true
}

variable "app_db_password" {
  description = "Password of the rd_app role, which the migrate task sets with ALTER ROLE."
  type        = string
  sensitive   = true
}

variable "recovery_window_in_days" {
  description = "Days a deleted secret stays recoverable (0 deletes immediately)."
  type        = number
  default     = 30
}
