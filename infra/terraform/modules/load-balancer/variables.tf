variable "name" {
  description = "Name prefix, e.g. rd-track-staging. ALB and target group names are limited to 32 characters."
  type        = string
}

variable "vpc_id" {
  description = "VPC for the target groups."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets for the ALB."
  type        = list(string)
}

variable "security_group_id" {
  description = "ALB security group."
  type        = string
}

variable "domain_name" {
  description = "Public host serving both the web app and the API, e.g. track.rounddigital.example."
  type        = string
}

variable "route53_zone_id" {
  description = "Hosted zone for domain_name. When set, ACM validation and the alias record are created; when null, create them by hand from the outputs."
  type        = string
  default     = null
}

variable "certificate_validation_timeout" {
  description = "How long apply waits for the ACM certificate to be issued (manual DNS needs time)."
  type        = string
  default     = "2h"
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

variable "api_path_patterns" {
  description = "Paths routed to the API; everything else goes to the web app. At most five per rule."
  type        = list(string)
  default     = ["/v1/*", "/platform/*", "/scim/*", "/healthz"]
}

variable "ssl_policy" {
  description = "TLS policy for the HTTPS listener (TLS 1.2 + 1.3, forward secrecy only)."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "hsts_header_value" {
  description = "Strict-Transport-Security value the ALB adds to every HTTPS response (null to leave it to the app)."
  type        = string
  default     = "max-age=31536000; includeSubDomains"
}

variable "idle_timeout" {
  description = "ALB idle timeout in seconds."
  type        = number
  default     = 60
}

variable "deletion_protection" {
  description = "Protect the ALB from deletion."
  type        = bool
  default     = true
}

variable "access_logs_bucket" {
  description = "Bucket for ALB access logs (SSE-S3). Null disables access logs."
  type        = string
  default     = null
}

variable "access_logs_prefix" {
  description = "Prefix for ALB access logs."
  type        = string
  default     = "alb"
}
