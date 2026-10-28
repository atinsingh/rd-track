variable "name" {
  description = "Name prefix, e.g. rd-track-staging."
  type        = string
}

variable "vpc_id" {
  description = "VPC to create the security groups in."
  type        = string
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

variable "db_port" {
  description = "PostgreSQL port."
  type        = number
  default     = 5432
}

variable "alb_ingress_cidrs" {
  description = "CIDRs allowed to reach the ALB on 80/443. Agents connect from anywhere, so this is normally the internet."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
