# Production: NAT per AZ, Multi-AZ RDS on Graviton m7g, 14-day backups/PITR,
# deletion protection everywhere, Enhanced Monitoring, Container Insights, VPC flow
# logs, 90-day logs.

module "stack" {
  source = "../../modules/app-stack"

  environment     = "production"
  app_domain      = var.app_domain
  route53_zone_id = var.route53_zone_id
  vpc_cidr        = var.vpc_cidr

  single_nat_gateway = false
  enable_flow_logs   = true

  db_instance_class        = "db.m7g.large"
  db_allocated_storage     = 50
  db_max_allocated_storage = 500
  db_multi_az              = true
  db_backup_retention_days = 14
  db_deletion_protection   = true
  db_monitoring_interval   = 60

  container_insights = "enabled"
  api_cpu            = 1024
  api_memory         = 2048
  api_min_count      = 2
  api_max_count      = 8
  worker_count       = 1
  web_min_count      = 2
  web_max_count      = 6
  log_retention_days = 90

  policy_signing_key_id = var.policy_signing_key_id
  ses_domain            = var.ses_domain
  email_from            = var.email_from
  billing_provider      = var.billing_provider
  stripe_price_standard = var.stripe_price_standard
  stripe_price_pro      = var.stripe_price_pro
  extra_app_environment = var.extra_app_environment

  alarm_topic_arn = var.alarm_topic_arn
  alarm_emails    = var.alarm_emails

  github_environment          = "production"
  create_github_oidc_provider = var.create_github_oidc_provider

  protect_resources = true
}
