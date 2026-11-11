# Staging: production-shaped (same modules, three AZs, two API/web tasks behind the
# ALB) but sized and protected for cost: one NAT gateway, single-AZ db.t4g.small,
# 3-day backups, no deletion protection, 30-day logs, no flow logs.
#
# `lean = true` shrinks it further for an account running on credits (runbook §1.0):
# two AZs, no interface endpoints, one API and one web task, db.t4g.micro.

module "stack" {
  source = "../../modules/app-stack"

  az_count            = var.lean ? 2 : 3
  interface_endpoints = var.lean ? [] : ["ecr.api", "ecr.dkr", "secretsmanager", "logs"]

  environment     = "staging"
  app_domain      = var.app_domain
  route53_zone_id = var.route53_zone_id
  vpc_cidr        = var.vpc_cidr

  single_nat_gateway = true
  enable_flow_logs   = false

  db_instance_class        = var.lean ? "db.t4g.micro" : "db.t4g.small"
  db_allocated_storage     = 20
  db_max_allocated_storage = 100
  db_multi_az              = false
  db_backup_retention_days = 3
  db_deletion_protection   = false
  db_monitoring_interval   = 0

  container_insights = "disabled"
  api_min_count      = var.lean ? 1 : 2
  api_max_count      = var.lean ? 2 : 4
  worker_count       = 1
  web_min_count      = var.lean ? 1 : 2
  web_max_count      = var.lean ? 2 : 3
  web_cpu            = var.lean ? 256 : 512
  web_memory         = var.lean ? 512 : 1024
  worker_cpu         = var.lean ? 256 : 512
  worker_memory      = var.lean ? 512 : 1024
  log_retention_days = 30

  policy_signing_key_id        = var.policy_signing_key_id
  ses_domain                   = var.ses_domain
  email_from                   = var.email_from
  billing_provider             = var.billing_provider
  stripe_price_standard        = var.stripe_price_standard
  stripe_price_pro             = var.stripe_price_pro
  stripe_price_standard_annual = var.stripe_price_standard_annual
  stripe_price_pro_annual      = var.stripe_price_pro_annual
  agent_download_base_url      = var.agent_download_base_url
  agent_version                = var.agent_version
  extra_app_environment        = var.extra_app_environment

  alarm_topic_arn = var.alarm_topic_arn
  alarm_emails    = var.alarm_emails

  github_environment          = "staging"
  create_github_oidc_provider = var.create_github_oidc_provider

  protect_resources = false
}
