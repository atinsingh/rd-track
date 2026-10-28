output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.this.id
}

output "vpc_cidr_block" {
  description = "VPC CIDR."
  value       = aws_vpc.this.cidr_block
}

output "availability_zones" {
  description = "AZs the subnets span."
  value       = local.azs
}

output "public_subnet_ids" {
  description = "Public subnets (ALB, NAT)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnets (ECS tasks)."
  value       = aws_subnet.private[*].id
}

output "isolated_subnet_ids" {
  description = "Isolated subnets (RDS)."
  value       = aws_subnet.isolated[*].id
}

output "nat_public_ips" {
  description = "Egress IPs of the NAT gateways (for allow-listing outbound calls, e.g. Stripe webhooks are inbound and need none)."
  value       = aws_eip.nat[*].public_ip
}
