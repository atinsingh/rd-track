# ECS on Fargate.
#
#   service  family            image          command                        secrets
#   api      <name>-api        rd-track-api   node dist/main.js (default)    app secrets
#   worker   <name>-worker     rd-track-api   node dist/worker.js            app secrets
#   web      <name>-web        rd-track-web   node apps/web/server.js        none
#   (task)   <name>-migrate    rd-track-api   db-role → migrate → db-role    owner URL, rd_app password
#
# Terraform registers the first revision of each family (image tag `initial_image_tag`)
# and owns everything except the image: the deploy pipeline copies the latest revision,
# swaps in the git-SHA image, registers it and points the service at it. Services
# therefore ignore `task_definition` (and `desired_count`, owned by autoscaling).
# A Terraform change to env/secrets/sizing registers a new revision, which the next
# deploy picks up.

data "aws_region" "current" {}

locals {
  region = data.aws_region.current.name

  owner_only_secrets = ["MIGRATION_DATABASE_URL", "APP_DB_PASSWORD"]
  app_secrets        = { for k, v in var.secret_arns : k => v if !contains(local.owner_only_secrets, k) }

  app_environment = [for k in sort(keys(var.app_environment)) : { name = k, value = var.app_environment[k] }]
  web_environment = [for k in sort(keys(var.web_environment)) : { name = k, value = var.web_environment[k] }]
  app_secret_refs = [for k in sort(keys(local.app_secrets)) : { name = k, valueFrom = local.app_secrets[k] }]

  api_image = "${var.api_repository_url}:${var.initial_image_tag}"
  web_image = "${var.web_repository_url}:${var.initial_image_tag}"

  log_groups = toset(["api", "worker", "web", "migrate"])

  bucket_object_arns = [for p in var.bucket_prefixes : "${var.bucket_arn}/${p}*"]

  # Shell is used only to chain the three steps; the JS arrives as one argument.
  migrate_command = [
    "sh", "-c",
    "node --input-type=module -e \"$DB_ROLE_JS\" && node dist/db/migrate-cli.js && node --input-type=module -e \"$DB_ROLE_JS\"",
  ]
}

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = var.container_insights
  }
}

resource "aws_cloudwatch_log_group" "this" {
  for_each          = local.log_groups
  name              = "/ecs/${var.name}/${each.value}"
  retention_in_days = var.log_retention_days
}

# =============================================================================
# IAM
# =============================================================================

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# --- Execution roles (used by the ECS agent: pull image, write logs, read secrets) ---

resource "aws_iam_role" "app_execution" {
  name               = "${var.name}-app-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "app_execution" {
  role       = aws_iam_role.app_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "app_execution_secrets" {
  statement {
    sid       = "ReadAppSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = values(var.secret_arns)
  }
  statement {
    sid       = "DecryptAppSecrets"
    actions   = ["kms:Decrypt"]
    resources = [var.secrets_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "app_execution_secrets" {
  name   = "read-app-secrets"
  role   = aws_iam_role.app_execution.id
  policy = data.aws_iam_policy_document.app_execution_secrets.json
}

# The web app needs no secrets, so its execution role cannot read any.
resource "aws_iam_role" "web_execution" {
  name               = "${var.name}-web-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "web_execution" {
  role       = aws_iam_role.web_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# --- Task roles (what the application code may call) -------------------------
# api and worker: objects under screenshots/ and exports/ in the one bucket, the
# bucket's CMK, and SES sending from the one identity. web and migrate: no task role.

data "aws_iam_policy_document" "app_task" {
  statement {
    sid       = "ObjectReadWrite"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = local.bucket_object_arns
  }

  # Lets HeadObject return 404 (not 403) for a missing key, which the API relies on.
  statement {
    sid       = "ListBucket"
    actions   = ["s3:ListBucket"]
    resources = [var.bucket_arn]
  }

  statement {
    sid       = "BucketKey"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.s3_kms_key_arn]
  }

  dynamic "statement" {
    for_each = var.ses_identity_arn == null ? [] : [1]
    content {
      sid       = "SendEmail"
      actions   = ["ses:SendEmail", "ses:SendRawEmail"]
      resources = [var.ses_identity_arn]
    }
  }
}

resource "aws_iam_role" "api_task" {
  name               = "${var.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "api_task" {
  name   = "app-objects-email"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.app_task.json
}

resource "aws_iam_role" "worker_task" {
  name               = "${var.name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "worker_task" {
  name   = "app-objects-email"
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.app_task.json
}

# =============================================================================
# Task definitions
# =============================================================================

locals {
  log_config = { for k in local.log_groups : k => {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = aws_cloudwatch_log_group.this[k].name
      "awslogs-region"        = local.region
      "awslogs-stream-prefix" = k
    }
  } }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.app_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name             = "api"
    image            = local.api_image
    essential        = true
    portMappings     = [{ name = "http", containerPort = var.api_port, protocol = "tcp" }]
    environment      = local.app_environment
    secrets          = local.app_secret_refs
    logConfiguration = local.log_config["api"]
    linuxParameters  = { initProcessEnabled = true }
    stopTimeout      = 30
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.app_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name             = "worker"
    image            = local.api_image
    essential        = true
    command          = ["node", "dist/worker.js"]
    environment      = local.app_environment
    secrets          = local.app_secret_refs
    logConfiguration = local.log_config["worker"]
    linuxParameters  = { initProcessEnabled = true }
    # Gives an in-flight job time to finish after SIGTERM.
    stopTimeout = 120
  }])
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  execution_role_arn       = aws_iam_role.web_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name             = "web"
    image            = local.web_image
    essential        = true
    portMappings     = [{ name = "http", containerPort = var.web_port, protocol = "tcp" }]
    environment      = local.web_environment
    logConfiguration = local.log_config["web"]
    linuxParameters  = { initProcessEnabled = true }
    stopTimeout      = 30
  }])
}

# Run by the deploy pipeline before services roll. Connects as the schema owner;
# ensures the rd_app role (before: so migrations may reference it; after: grants on
# new objects), then applies migrations. Exit code 0 = success.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.migrate_cpu
  memory                   = var.migrate_memory
  execution_role_arn       = aws_iam_role.app_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = local.api_image
    essential = true
    command   = local.migrate_command
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "APP_DB_ROLE", value = var.app_db_role },
      { name = "DB_ROLE_JS", value = file("${path.module}/db-role.mjs") },
    ]
    secrets = [
      # migrate-cli reads DATABASE_URL; here (only here) it is the owner's URL.
      { name = "DATABASE_URL", valueFrom = var.secret_arns["MIGRATION_DATABASE_URL"] },
      { name = "APP_DB_PASSWORD", valueFrom = var.secret_arns["APP_DB_PASSWORD"] },
    ]
    logConfiguration = local.log_config["migrate"]
  }])
}

# =============================================================================
# Services
# =============================================================================

resource "aws_ecs_service" "api" {
  name                               = "api"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_min_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  health_check_grace_period_seconds  = var.health_check_grace_period
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.api_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.api_target_group_arn
    container_name   = "api"
    container_port   = var.api_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

resource "aws_ecs_service" "worker" {
  name                               = "worker"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = var.worker_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.worker_security_group_id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}

resource "aws_ecs_service" "web" {
  name                               = "web"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.web.arn
  desired_count                      = var.web_min_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  health_check_grace_period_seconds  = var.health_check_grace_period
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.web_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.web_target_group_arn
    container_name   = "web"
    container_port   = var.web_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

# =============================================================================
# Autoscaling (CPU target tracking)
# =============================================================================

locals {
  scaled = {
    api = { service = aws_ecs_service.api.name, min = var.api_min_count, max = var.api_max_count }
    web = { service = aws_ecs_service.web.name, min = var.web_min_count, max = var.web_max_count }
  }
}

resource "aws_appautoscaling_target" "this" {
  for_each           = local.scaled
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${each.value.service}"
  min_capacity       = each.value.min
  max_capacity       = each.value.max
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = local.scaled
  name               = "${var.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.this[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.this[each.key].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_percent
    scale_out_cooldown = 60
    scale_in_cooldown  = 300

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
