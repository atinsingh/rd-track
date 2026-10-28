variable "name" {
  description = "Name prefix for every resource, e.g. rd-track-staging."
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR. Must be a /16: public and isolated subnets are /24s, private subnets /20s."
  type        = string

  validation {
    condition     = can(cidrhost(var.cidr_block, 0)) && endswith(var.cidr_block, "/16")
    error_message = "cidr_block must be a valid /16 CIDR."
  }
}

variable "az_count" {
  description = "Number of availability zones to span (ca-central-1 has three)."
  type        = number
  default     = 3

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3 (RDS Multi-AZ needs at least two)."
  }
}

variable "single_nat_gateway" {
  description = "One shared NAT gateway (cheaper, staging) instead of one per AZ (production; survives an AZ outage)."
  type        = bool
  default     = false
}

variable "interface_endpoints" {
  description = "AWS services reached through interface VPC endpoints instead of NAT. Each costs roughly USD 7-8/month per AZ plus data."
  type        = list(string)
  default     = ["ecr.api", "ecr.dkr", "secretsmanager", "logs"]
}

variable "enable_flow_logs" {
  description = "Send VPC flow logs to CloudWatch Logs."
  type        = bool
  default     = true
}

variable "flow_log_retention_days" {
  description = "Retention for the VPC flow log group."
  type        = number
  default     = 90
}

variable "flow_log_traffic_type" {
  description = "ACCEPT, REJECT or ALL."
  type        = string
  default     = "ALL"
}
