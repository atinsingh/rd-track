output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "service_names" {
  description = "Service names by role."
  value = {
    api    = aws_ecs_service.api.name
    worker = aws_ecs_service.worker.name
    web    = aws_ecs_service.web.name
  }
}

output "service_arns" {
  description = "Service ARNs (for the deploy role)."
  value = [
    aws_ecs_service.api.id,
    aws_ecs_service.worker.id,
    aws_ecs_service.web.id,
  ]
}

output "task_families" {
  description = "Task definition families by role."
  value = {
    api     = aws_ecs_task_definition.api.family
    worker  = aws_ecs_task_definition.worker.family
    web     = aws_ecs_task_definition.web.family
    migrate = aws_ecs_task_definition.migrate.family
  }
}

output "pass_role_arns" {
  description = "Roles the deploy pipeline must be allowed to pass when registering task definitions."
  value = [
    aws_iam_role.app_execution.arn,
    aws_iam_role.web_execution.arn,
    aws_iam_role.api_task.arn,
    aws_iam_role.worker_task.arn,
  ]
}

output "log_group_arns" {
  description = "Task log group ARNs by role."
  value       = { for k, g in aws_cloudwatch_log_group.this : k => g.arn }
}

output "log_group_names" {
  description = "Task log group names by role."
  value       = { for k, g in aws_cloudwatch_log_group.this : k => g.name }
}
