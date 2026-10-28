output "secret_arns" {
  description = "Map of environment variable name → secret ARN, ready for ECS `secrets`."
  value = merge(
    { for k, s in aws_secretsmanager_secret.operator : k => s.arn },
    { for k, s in aws_secretsmanager_secret.managed : k => s.arn },
  )
}

output "secret_names" {
  description = "Map of environment variable name → secret name (for put-secret-value)."
  value = merge(
    { for k, s in aws_secretsmanager_secret.operator : k => s.name },
    { for k, s in aws_secretsmanager_secret.managed : k => s.name },
  )
}
