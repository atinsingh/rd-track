output "instance_id" {
  description = "RDS instance identifier (CloudWatch DBInstanceIdentifier)."
  value       = aws_db_instance.this.identifier
}

output "instance_arn" {
  description = "RDS instance ARN."
  value       = aws_db_instance.this.arn
}

output "address" {
  description = "Endpoint hostname."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "Endpoint port."
  value       = aws_db_instance.this.port
}

output "db_name" {
  description = "Database name."
  value       = aws_db_instance.this.db_name
}

output "username" {
  description = "Master user name."
  value       = aws_db_instance.this.username
}

output "app_username" {
  description = "Application login role."
  value       = var.app_username
}

output "app_password" {
  description = "Application role password (inside DATABASE_URL and APP_DB_PASSWORD secrets)."
  value       = random_password.app.result
  sensitive   = true
}

output "password" {
  description = "Master password (inside the MIGRATION_DATABASE_URL secret)."
  value       = random_password.master.result
  sensitive   = true
}

output "allocated_storage_gib" {
  description = "Initial allocated storage."
  value       = var.allocated_storage
}
