output "app_url" {
  description = "Public URL (web app and API share it)."
  value       = local.app_url
}

output "alb_dns_name" {
  description = "Point app_domain here (alias A record, or CNAME) when DNS is not managed by Terraform."
  value       = module.load_balancer.alb_dns_name
}

output "acm_validation_records" {
  description = "CNAMEs that validate the TLS certificate (create by hand if route53_zone_id is null)."
  value       = module.load_balancer.acm_validation_records
}

output "ses_dns_records" {
  description = "DKIM, MAIL FROM and recommended DMARC records for the SES domain."
  value       = module.email.dns_records
}

output "ecr_repository_urls" {
  description = "Image repositories."
  value       = module.ecr.repository_urls
}

output "ecs_cluster_name" {
  description = "ECS cluster (also NAME_PREFIX for the deploy workflow)."
  value       = module.ecs.cluster_name
}

output "ecs_task_families" {
  description = "Task definition families."
  value       = module.ecs.task_families
}

output "ecs_log_groups" {
  description = "CloudWatch log groups of the tasks."
  value       = module.ecs.log_group_names
}

output "worker_security_group_id" {
  description = "Security group for one-off tasks (e.g. create-platform-admin)."
  value       = module.security_groups.worker_security_group_id
}

output "private_subnet_ids" {
  description = "Subnets for one-off tasks."
  value       = module.network.private_subnet_ids
}

output "db_instance_id" {
  description = "RDS instance identifier (for restores)."
  value       = module.database.instance_id
}

output "db_address" {
  description = "RDS endpoint hostname."
  value       = module.database.address
}

output "object_bucket_name" {
  description = "Object bucket."
  value       = module.object_storage.bucket_name
}

output "secret_names" {
  description = "Secrets Manager names by env var. Operator-provided ones start as REPLACE_ME."
  value       = module.secrets.secret_names
}

output "alarm_topic_arn" {
  description = "SNS topic receiving alarms."
  value       = module.monitoring.alarm_topic_arn
}

output "nat_public_ips" {
  description = "Outbound IPs of the tasks."
  value       = module.network.nat_public_ips
}

output "github_environment_variables" {
  description = "Set these as variables on the GitHub environment used by deploy.yml."
  value = {
    AWS_DEPLOY_ROLE_ARN = module.github_oidc.role_arn
    AWS_REGION          = local.region
    NAME_PREFIX         = module.ecs.cluster_name
    APP_HOST            = var.app_domain
  }
}
