output "rds_key_arn" {
  description = "CMK for RDS."
  value       = aws_kms_key.this["rds"].arn
}

output "s3_key_arn" {
  description = "CMK for the object bucket."
  value       = aws_kms_key.this["s3"].arn
}

output "secrets_key_arn" {
  description = "CMK for Secrets Manager."
  value       = aws_kms_key.this["secrets"].arn
}
