output "app_url" {
  description = "Public URL."
  value       = module.stack.app_url
}

output "alb_dns_name" {
  description = "ALB DNS name (target of the app_domain record)."
  value       = module.stack.alb_dns_name
}

output "acm_validation_records" {
  description = "Certificate validation CNAMEs."
  value       = module.stack.acm_validation_records
}

output "ses_dns_records" {
  description = "SES DKIM / MAIL FROM / DMARC records."
  value       = module.stack.ses_dns_records
}

output "ecr_repository_urls" {
  description = "Image repositories."
  value       = module.stack.ecr_repository_urls
}

output "ecs_cluster_name" {
  description = "ECS cluster."
  value       = module.stack.ecs_cluster_name
}

output "ecs_task_families" {
  description = "Task definition families."
  value       = module.stack.ecs_task_families
}

output "ecs_log_groups" {
  description = "Task log groups."
  value       = module.stack.ecs_log_groups
}

output "worker_security_group_id" {
  description = "Security group for one-off tasks."
  value       = module.stack.worker_security_group_id
}

output "private_subnet_ids" {
  description = "Subnets for one-off tasks."
  value       = module.stack.private_subnet_ids
}

output "db_instance_id" {
  description = "RDS instance identifier."
  value       = module.stack.db_instance_id
}

output "object_bucket_name" {
  description = "Object bucket."
  value       = module.stack.object_bucket_name
}

output "secret_names" {
  description = "Secrets Manager names."
  value       = module.stack.secret_names
}

output "alarm_topic_arn" {
  description = "Alarm topic."
  value       = module.stack.alarm_topic_arn
}

output "nat_public_ips" {
  description = "Outbound IPs."
  value       = module.stack.nat_public_ips
}

output "github_environment_variables" {
  description = "Variables for the GitHub environment."
  value       = module.stack.github_environment_variables
}
