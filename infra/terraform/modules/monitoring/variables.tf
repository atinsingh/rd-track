variable "name" {
  description = "Name prefix, e.g. rd-track-staging."
  type        = string
}

variable "alarm_topic_arn" {
  description = "Existing SNS topic for alarms (e.g. wired to PagerDuty/Slack). Null creates <name>-alarms."
  type        = string
  default     = null
}

variable "alarm_emails" {
  description = "Email addresses subscribed to the created topic (each must confirm). Ignored when alarm_topic_arn is set."
  type        = list(string)
  default     = []
}

variable "alb_arn_suffix" {
  description = "ALB ARN suffix."
  type        = string
}

variable "api_target_group_arn_suffix" {
  description = "API target group ARN suffix."
  type        = string
}

variable "db_instance_id" {
  description = "RDS instance identifier."
  type        = string
}

variable "cluster_name" {
  description = "ECS cluster name."
  type        = string
}

variable "worker_service_name" {
  description = "Worker service name."
  type        = string
}

variable "alb_5xx_rate_percent" {
  description = "Alarm when 5xx (target + ALB) exceed this % of requests."
  type        = number
  default     = 5
}

variable "alb_5xx_min_requests" {
  description = "Ignore 5xx rate in minutes with fewer requests than this (quiet hours)."
  type        = number
  default     = 20
}

variable "api_p95_latency_seconds" {
  description = "Alarm when API p95 target response time exceeds this."
  type        = number
  default     = 1.5
}

variable "db_cpu_percent" {
  description = "Alarm when RDS CPU exceeds this."
  type        = number
  default     = 80
}

variable "db_free_storage_bytes" {
  description = "Alarm when RDS free storage drops below this many bytes."
  type        = number
}
