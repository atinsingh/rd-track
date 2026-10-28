# All security groups in one place so the references between them (ALB → tasks,
# tasks → RDS) do not create cycles between modules.
#
#   internet ──443/80──► alb ──4000──► api ──5432──► db
#                           └──3000──► web       ▲
#                                     worker ────┘   (migrate and one-off tasks use worker)
#
# Task egress is HTTPS (VPC endpoints, S3 gateway, SES, Stripe through NAT) plus
# PostgreSQL to the database group only. DNS to the VPC resolver is not subject to
# security groups.

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public HTTPS load balancer"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-alb" }
}

resource "aws_security_group" "api" {
  name        = "${var.name}-api"
  description = "API tasks"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-api" }
}

resource "aws_security_group" "web" {
  name        = "${var.name}-web"
  description = "Web (Next.js) tasks"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-web" }
}

resource "aws_security_group" "worker" {
  name        = "${var.name}-worker"
  description = "Worker, migration and one-off admin tasks (no inbound)"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-worker" }
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "RDS PostgreSQL: only from API and worker tasks"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-db" }
}

# --- ALB --------------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each          = toset(var.alb_ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each          = toset(var.alb_ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  description       = "HTTP (redirected to HTTPS)"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To API tasks"
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To web tasks"
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "tcp"
  from_port                    = var.web_port
  to_port                      = var.web_port
}

# --- Tasks ------------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  description                  = "From the ALB"
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web.id
  description                  = "From the ALB"
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = var.web_port
  to_port                      = var.web_port
}

locals {
  task_groups = {
    api    = aws_security_group.api.id
    web    = aws_security_group.web.id
    worker = aws_security_group.worker.id
  }
  db_clients = {
    api    = aws_security_group.api.id
    worker = aws_security_group.worker.id
  }
}

resource "aws_vpc_security_group_egress_rule" "tasks_https" {
  for_each          = local.task_groups
  security_group_id = each.value
  description       = "HTTPS to AWS endpoints, S3, SES and third-party APIs"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "tasks_to_db" {
  for_each                     = local.db_clients
  security_group_id            = each.value
  description                  = "PostgreSQL"
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
}

# --- Database ---------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "db_from_tasks" {
  for_each                     = local.db_clients
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from ${each.key} tasks"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
}
