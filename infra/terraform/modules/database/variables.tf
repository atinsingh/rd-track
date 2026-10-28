variable "name" {
  description = "Name prefix, e.g. rd-track-staging. The instance is <name>-db."
  type        = string
}

variable "subnet_ids" {
  description = "Isolated subnets for the DB subnet group."
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group that admits only ECS tasks."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK for storage, snapshots and Performance Insights."
  type        = string
}

variable "engine_version" {
  description = "PostgreSQL version. A major version (\"16\") lets RDS pick and auto-upgrade minors."
  type        = string
  default     = "16"
}

variable "instance_class" {
  description = "Instance class. Graviton (m7g/t4g) is the cheapest per vCPU."
  type        = string
}

variable "allocated_storage" {
  description = "Initial gp3 storage in GiB."
  type        = number
  default     = 20
}

variable "max_allocated_storage" {
  description = "Storage autoscaling ceiling in GiB."
  type        = number
  default     = 100
}

variable "multi_az" {
  description = "Synchronous standby in a second AZ (production)."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "Automated backup retention, which is also the point-in-time-restore window."
  type        = number
}

variable "backup_window" {
  description = "Daily backup window (UTC)."
  type        = string
  default     = "06:00-06:30"
}

variable "maintenance_window" {
  description = "Weekly maintenance window (UTC); must not overlap the backup window."
  type        = string
  default     = "sun:07:00-sun:08:00"
}

variable "deletion_protection" {
  description = "Refuse DeleteDBInstance until turned off."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy (staging only)."
  type        = bool
  default     = false
}

variable "performance_insights_retention_days" {
  description = "7 is free; longer retention is billed."
  type        = number
  default     = 7
}

variable "monitoring_interval" {
  description = "Enhanced Monitoring interval in seconds (0 disables; 60 is cheap and useful)."
  type        = number
  default     = 0
}

variable "log_retention_days" {
  description = "Retention for the RDS log groups exported to CloudWatch."
  type        = number
  default     = 30
}

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "rd_track"
}

variable "app_username" {
  description = "Least-privilege login role the API and worker connect as (subject to RLS)."
  type        = string
  default     = "rd_app"
}

variable "username" {
  description = "Master user name: owns the schema; used only by the migrate task."
  type        = string
  default     = "rdtrack"
}

variable "log_min_duration_statement_ms" {
  description = "Log statements slower than this (ms); -1 disables."
  type        = number
  default     = 1000
}

variable "apply_immediately" {
  description = "Apply modifications now instead of in the maintenance window."
  type        = bool
  default     = false
}
