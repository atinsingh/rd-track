# Alarms → SNS. Each alarm also notifies on recovery (OK).
#   ALB 5xx rate · API p95 latency · RDS CPU · RDS free storage · worker running count 0

locals {
  topic_arn = coalesce(var.alarm_topic_arn, try(aws_sns_topic.alarms[0].arn, null))
  actions   = [local.topic_arn]
}

resource "aws_sns_topic" "alarms" {
  count = var.alarm_topic_arn == null ? 1 : 0
  name  = "${var.name}-alarms"
  # Not KMS-encrypted: alarm payloads carry no customer data, and CloudWatch cannot
  # publish to a topic encrypted with the AWS-managed SNS key.
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = var.alarm_topic_arn == null ? toset(var.alarm_emails) : toset([])
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx_rate" {
  alarm_name          = "${var.name}-alb-5xx-rate"
  alarm_description   = "More than ${var.alb_5xx_rate_percent}% of requests returned 5xx (targets + ALB) for 5 minutes."
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alb_5xx_rate_percent
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  metric_query {
    id          = "rate"
    label       = "5xx %"
    return_data = true
    expression  = "IF(requests >= ${var.alb_5xx_min_requests}, 100 * (FILL(target5xx, 0) + FILL(elb5xx, 0)) / requests, 0)"
  }

  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
      stat        = "Sum"
      period      = 60
    }
  }

  metric_query {
    id = "target5xx"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
      stat        = "Sum"
      period      = 60
    }
  }

  metric_query {
    id = "elb5xx"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
      stat        = "Sum"
      period      = 60
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "api_p95_latency" {
  alarm_name          = "${var.name}-api-p95-latency"
  alarm_description   = "API p95 response time above ${var.api_p95_latency_seconds}s for 15 minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.api_p95_latency_seconds
  treat_missing_data  = "notBreaching"
  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.api_target_group_arn_suffix
  }
  alarm_actions = local.actions
  ok_actions    = local.actions
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${var.name}-rds-cpu"
  alarm_description   = "RDS CPU above ${var.db_cpu_percent}% for 15 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.db_cpu_percent
  treat_missing_data  = "breaching"
  dimensions          = { DBInstanceIdentifier = var.db_instance_id }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "db_free_storage" {
  alarm_name          = "${var.name}-rds-free-storage"
  alarm_description   = "RDS free storage below ${floor(var.db_free_storage_bytes / 1073741824)} GiB (storage autoscaling may be at its ceiling)."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = var.db_free_storage_bytes
  treat_missing_data  = "breaching"
  dimensions          = { DBInstanceIdentifier = var.db_instance_id }
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# AWS/ECS service metrics are published once a minute per running task; SampleCount
# of CPUUtilization is therefore the number of reporting tasks, and no data at all
# means no worker is running. Works without Container Insights.
resource "aws_cloudwatch_metric_alarm" "worker_not_running" {
  alarm_name          = "${var.name}-worker-not-running"
  alarm_description   = "No worker task has been running for 5 minutes: ingestion aggregation, screenshots verification, exports and retention are stalled."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "SampleCount"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  dimensions = {
    ClusterName = var.cluster_name
    ServiceName = var.worker_service_name
  }
  alarm_actions = local.actions
  ok_actions    = local.actions
}
