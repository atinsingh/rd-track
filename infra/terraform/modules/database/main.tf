# RDS for PostgreSQL 16. Isolated subnets, no public address, CMK encryption, TLS
# forced by the parameter group, automated backups (= point-in-time restore with
# ~5-minute RPO), Performance Insights, logs to CloudWatch.

locals {
  identifier = "${var.name}-db"
}

resource "random_password" "master" {
  length = 40
  # URL-safe: the password is embedded in DATABASE_URL without encoding.
  special = false
}

# Login role for the API and worker (rd_app by default). It owns nothing and is not a
# superuser / BYPASSRLS, so Postgres row-level security applies to it. The role is
# created and granted by the migrate task (see modules/ecs), not by Terraform:
# Terraform cannot reach a database in isolated subnets.
resource "random_password" "app" {
  length  = 40
  special = false
}

resource "aws_db_subnet_group" "this" {
  name        = local.identifier
  description = "Isolated subnets for ${local.identifier}"
  subnet_ids  = var.subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name_prefix = "${local.identifier}-pg16-"
  family      = "postgres16"
  description = "rd-track: TLS required, slow-query logging"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name         = "ssl_min_protocol_version"
    value        = "TLSv1.2"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = tostring(var.log_min_duration_statement_ms)
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "rds" {
  for_each          = toset(["postgresql", "upgrade"])
  name              = "/aws/rds/instance/${local.identifier}/${each.value}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "monitoring" {
  count              = var.monitoring_interval > 0 ? 1 : 0
  name               = "${local.identifier}-enhanced-monitoring"
  assume_role_policy = data.aws_iam_policy_document.monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  count      = var.monitoring_interval > 0 ? 1 : 0
  role       = aws_iam_role.monitoring[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  identifier     = local.identifier
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  db_name  = var.db_name
  username = var.username
  password = random_password.master.result
  port     = 5432

  storage_type          = "gp3"
  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.security_group_id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.this.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  backup_retention_period  = var.backup_retention_days
  backup_window            = var.backup_window
  maintenance_window       = var.maintenance_window
  copy_tags_to_snapshot    = true
  delete_automated_backups = false

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${local.identifier}-final"

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = var.performance_insights_retention_days
  monitoring_interval                   = var.monitoring_interval
  monitoring_role_arn                   = var.monitoring_interval > 0 ? aws_iam_role.monitoring[0].arn : null
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false
  apply_immediately           = var.apply_immediately

  depends_on = [aws_cloudwatch_log_group.rds]
}
