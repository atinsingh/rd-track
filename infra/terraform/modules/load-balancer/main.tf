# One public host, one ALB:
#   :80   → 301 to https
#   :443  → /v1/*, /platform/*, /scim/*, /healthz → api target group
#           everything else            → web target group
# Browser and agent traffic to /v1 goes straight to the API; the web app's own /v1
# rewrite (next.config.ts) is therefore only a fallback behind this ALB, and the
# session cookie stays first-party because both share the host.

locals {
  manage_dns = var.route53_zone_id != null
  validation = { for o in aws_acm_certificate.this.domain_validation_options : o.domain_name => o }
}

# --- Certificate ------------------------------------------------------------

resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# Keyed by the (static) domain so the plan never depends on apply-time values.
resource "aws_route53_record" "validation" {
  for_each = local.manage_dns ? toset([var.domain_name]) : toset([])

  zone_id         = var.route53_zone_id
  name            = local.validation[each.key].resource_record_name
  type            = local.validation[each.key].resource_record_type
  records         = [local.validation[each.key].resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

# Waits until ACM reports ISSUED. Without a managed zone, create the CNAME from the
# `acm_validation_records` output while this waits (see the runbook).
resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = local.manage_dns ? [for r in aws_route53_record.validation : r.fqdn] : null

  timeouts {
    create = var.certificate_validation_timeout
  }
}

# --- Load balancer ----------------------------------------------------------

resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.public_subnet_ids
  security_groups            = [var.security_group_id]
  idle_timeout               = var.idle_timeout
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  # The API trusts X-Forwarded-For from the ALB for per-IP login rate limits;
  # `append` keeps the ALB-observed client address as the right-most entry.
  xff_header_processing_mode = "append"

  dynamic "access_logs" {
    for_each = var.access_logs_bucket == null ? [] : [1]
    content {
      bucket  = var.access_logs_bucket
      prefix  = var.access_logs_prefix
      enabled = true
    }
  }
}

resource "aws_lb_target_group" "api" {
  name                 = "${var.name}-api"
  port                 = var.api_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_target_group" "web" {
  name                 = "${var.name}-web"
  port                 = var.web_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = "/login"
    matcher             = "200-399"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = aws_acm_certificate_validation.this.certificate_arn

  # ALB response-header modification (GA Nov 2024): HSTS on every HTTPS response,
  # including API and ALB-generated error responses. The web app should still send
  # HSTS itself so the header survives a move off ALB (see runbook follow-ups).
  routing_http_response_strict_transport_security_header_value = var.hsts_header_value
  routing_http_response_server_enabled                         = false

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  condition {
    path_pattern {
      values = var.api_path_patterns
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# --- DNS --------------------------------------------------------------------

resource "aws_route53_record" "app" {
  count   = local.manage_dns ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
