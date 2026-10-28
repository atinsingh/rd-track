output "alarm_topic_arn" {
  description = "SNS topic receiving alarms."
  value       = local.topic_arn
}
