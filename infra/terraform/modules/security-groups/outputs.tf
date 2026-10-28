output "alb_security_group_id" {
  description = "ALB security group."
  value       = aws_security_group.alb.id
}

output "api_security_group_id" {
  description = "API task security group."
  value       = aws_security_group.api.id
}

output "web_security_group_id" {
  description = "Web task security group."
  value       = aws_security_group.web.id
}

output "worker_security_group_id" {
  description = "Worker / migrate / one-off task security group."
  value       = aws_security_group.worker.id
}

output "db_security_group_id" {
  description = "RDS security group."
  value       = aws_security_group.db.id
}
