output "alb_arn" {
  description = "ALB ARN."
  value       = aws_lb.this.arn
}

output "alb_arn_suffix" {
  description = "ALB ARN suffix (CloudWatch LoadBalancer dimension)."
  value       = aws_lb.this.arn_suffix
}

output "alb_dns_name" {
  description = "ALB DNS name: point the app host at it (alias/CNAME) when DNS is not managed here."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "ALB hosted zone ID (for alias records)."
  value       = aws_lb.this.zone_id
}

output "api_target_group_arn" {
  description = "API target group."
  value       = aws_lb_target_group.api.arn
}

output "api_target_group_arn_suffix" {
  description = "API target group ARN suffix (CloudWatch TargetGroup dimension)."
  value       = aws_lb_target_group.api.arn_suffix
}

output "web_target_group_arn" {
  description = "Web target group."
  value       = aws_lb_target_group.web.arn
}

output "https_listener_arn" {
  description = "HTTPS listener (ECS services depend on it so target groups are attached)."
  value       = aws_lb_listener.https.arn
}

output "certificate_arn" {
  description = "ACM certificate ARN."
  value       = aws_acm_certificate.this.arn
}

output "acm_validation_records" {
  description = "CNAME records that prove domain ownership to ACM."
  value = [for o in aws_acm_certificate.this.domain_validation_options : {
    name  = o.resource_record_name
    type  = o.resource_record_type
    value = o.resource_record_value
  }]
}
