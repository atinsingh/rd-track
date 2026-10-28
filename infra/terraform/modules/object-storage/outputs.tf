output "bucket_name" {
  description = "Object bucket name (S3_BUCKET)."
  value       = aws_s3_bucket.objects.id
}

output "bucket_arn" {
  description = "Object bucket ARN."
  value       = aws_s3_bucket.objects.arn
}

output "logs_bucket_name" {
  description = "Access-log bucket name (available once its policy lets ELB and S3 write)."
  value       = aws_s3_bucket.logs.id
  depends_on  = [aws_s3_bucket_policy.logs]
}

output "alb_log_prefix" {
  description = "Prefix for ALB access logs in the logs bucket."
  value       = var.alb_log_prefix
}

