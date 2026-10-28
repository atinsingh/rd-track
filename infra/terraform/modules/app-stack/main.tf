# One complete RoundDigital Track deployment (one region, one AWS account).
# envs/staging and envs/production are thin wrappers around this module, so the two
# environments cannot drift structurally — only in the sizes and switches below.
#
# Data residency (commercial model §5): a Pro residency region is another instance of
# this stack in that region with its own state.

data "aws_region" "current" {}

locals {
  name    = "${var.project}-${var.environment}"
  region  = data.aws_region.current.name
  app_url = "https://${var.app_domain}"
  protect = var.protect_resources

  # Baked into the API image (apps/api/Dockerfile). pg reads sslrootcert itself, so
  # verify-full checks the RDS chain and hostname without touching Node's global CAs.
  rds_ca_bundle = "/usr/local/share/rds/rds-global-bundle.pem"

  app_environment = merge({
    NODE_ENV                      = "production"
    PORT                          = "4000"
    LOG_LEVEL                     = "info"
    DB_POOL_MAX                   = "10"
    STORAGE                       = "s3"
    S3_BUCKET                     = module.object_storage.bucket_name
    S3_REGION                     = local.region
    PUBLIC_API_URL                = local.app_url
    PUBLIC_WEB_URL                = local.app_url
    POLICY_SIGNING_KEY_ID         = var.policy_signing_key_id
    MFA_REQUIRED_FOR_ADMINS       = "true"
    EMAIL_PROVIDER                = "ses"
    EMAIL_FROM                    = var.email_from
    SES_REGION                    = local.region
    BILLING_PROVIDER              = var.billing_provider
    STRIPE_PRICE_STANDARD_MONTHLY = var.stripe_price_standard
    STRIPE_PRICE_PRO_MONTHLY      = var.stripe_price_pro
    STRIPE_PRICE_STANDARD_ANNUAL  = var.stripe_price_standard_annual
    STRIPE_PRICE_PRO_ANNUAL       = var.stripe_price_pro_annual
  }, var.extra_app_environment)

  web_environment = {
    NODE_ENV = "production"
    PORT     = "3000"
    HOSTNAME = "0.0.0.0"
    # Rewrites are baked at build time; this only serves any future server-side code.
    API_URL = local.app_url
  }

  db_query     = "sslmode=verify-full&sslrootcert=${local.rds_ca_bundle}"
  db_host      = "${module.database.address}:${module.database.port}/${module.database.db_name}"
  app_db_url   = "postgres://${module.database.app_username}:${module.database.app_password}@${local.db_host}?${local.db_query}"
  owner_db_url = "postgres://${module.database.username}:${module.database.password}@${local.db_host}?${local.db_query}"
  free_storage = max(2, floor(var.db_allocated_storage * 0.2)) * 1073741824
  github_env   = coalesce(var.github_environment, var.environment)
}

module "network" {
  source                  = "../network"
  name                    = local.name
  cidr_block              = var.vpc_cidr
  single_nat_gateway      = var.single_nat_gateway
  enable_flow_logs        = var.enable_flow_logs
  flow_log_retention_days = var.log_retention_days
}

module "kms" {
  source                  = "../kms"
  name                    = local.name
  deletion_window_in_days = local.protect ? 30 : 7
}

module "security_groups" {
  source = "../security-groups"
  name   = local.name
  vpc_id = module.network.vpc_id
}

module "object_storage" {
  source               = "../object-storage"
  name                 = local.name
  kms_key_arn          = module.kms.s3_key_arn
  cors_allowed_origins = [local.app_url]
  logs_expiration_days = local.protect ? 365 : 90
  force_destroy        = !local.protect
}

module "database" {
  source                = "../database"
  name                  = local.name
  subnet_ids            = module.network.isolated_subnet_ids
  security_group_id     = module.security_groups.db_security_group_id
  kms_key_arn           = module.kms.rds_key_arn
  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  multi_az              = var.db_multi_az
  backup_retention_days = var.db_backup_retention_days
  deletion_protection   = var.db_deletion_protection
  skip_final_snapshot   = !local.protect
  monitoring_interval   = var.db_monitoring_interval
  log_retention_days    = var.log_retention_days
}

module "secrets" {
  source                  = "../secrets"
  name                    = local.name
  kms_key_arn             = module.kms.secrets_key_arn
  database_url            = local.app_db_url
  migration_database_url  = local.owner_db_url
  app_db_password         = module.database.app_password
  recovery_window_in_days = local.protect ? 30 : 0
}

module "ecr" {
  source       = "../ecr"
  force_delete = !local.protect
}

module "load_balancer" {
  source              = "../load-balancer"
  name                = local.name
  vpc_id              = module.network.vpc_id
  public_subnet_ids   = module.network.public_subnet_ids
  security_group_id   = module.security_groups.alb_security_group_id
  domain_name         = var.app_domain
  route53_zone_id     = var.route53_zone_id
  deletion_protection = local.protect
  access_logs_bucket  = module.object_storage.logs_bucket_name
  access_logs_prefix  = module.object_storage.alb_log_prefix
}

module "email" {
  source          = "../email"
  name            = local.name
  domain          = var.ses_domain
  route53_zone_id = var.route53_zone_id
}

module "ecs" {
  source = "../ecs"
  name   = local.name

  container_insights       = var.container_insights
  private_subnet_ids       = module.network.private_subnet_ids
  api_security_group_id    = module.security_groups.api_security_group_id
  web_security_group_id    = module.security_groups.web_security_group_id
  worker_security_group_id = module.security_groups.worker_security_group_id
  api_target_group_arn     = module.load_balancer.api_target_group_arn
  web_target_group_arn     = module.load_balancer.web_target_group_arn
  api_repository_url       = module.ecr.repository_urls["rd-track-api"]
  web_repository_url       = module.ecr.repository_urls["rd-track-web"]

  api_cpu       = var.api_cpu
  api_memory    = var.api_memory
  api_min_count = var.api_min_count
  api_max_count = var.api_max_count
  worker_cpu    = var.worker_cpu
  worker_memory = var.worker_memory
  worker_count  = var.worker_count
  web_cpu       = var.web_cpu
  web_memory    = var.web_memory
  web_min_count = var.web_min_count
  web_max_count = var.web_max_count

  log_retention_days  = var.log_retention_days
  app_environment     = local.app_environment
  web_environment     = local.web_environment
  secret_arns         = module.secrets.secret_arns
  secrets_kms_key_arn = module.kms.secrets_key_arn
  app_db_role         = module.database.app_username
  bucket_arn          = module.object_storage.bucket_arn
  s3_kms_key_arn      = module.kms.s3_key_arn
  ses_identity_arn    = module.email.identity_arn
}

module "github_oidc" {
  source               = "../github-oidc"
  name                 = local.name
  github_repository    = var.github_repository
  github_environment   = local.github_env
  create_oidc_provider = var.create_github_oidc_provider
  ecr_repository_arns  = values(module.ecr.repository_arns)
  cluster_arn          = module.ecs.cluster_arn
  service_arns         = module.ecs.service_arns
  run_task_families    = [module.ecs.task_families["migrate"]]
  pass_role_arns       = module.ecs.pass_role_arns
  log_group_arns       = [module.ecs.log_group_arns["migrate"]]
}

module "monitoring" {
  source                      = "../monitoring"
  name                        = local.name
  alarm_topic_arn             = var.alarm_topic_arn
  alarm_emails                = var.alarm_emails
  alb_arn_suffix              = module.load_balancer.alb_arn_suffix
  api_target_group_arn_suffix = module.load_balancer.api_target_group_arn_suffix
  db_instance_id              = module.database.instance_id
  cluster_name                = module.ecs.cluster_name
  worker_service_name         = module.ecs.service_names["worker"]
  db_free_storage_bytes       = local.free_storage
}
