output "identity_arn" {
  description = "SES identity ARN (task roles may send from it)."
  value       = aws_sesv2_email_identity.this.arn
}

output "configuration_set_name" {
  description = "Default configuration set of the identity."
  value       = aws_sesv2_configuration_set.this.configuration_set_name
}

output "dns_records" {
  description = "DNS records SES needs (created automatically when route53_zone_id is set). DMARC is a recommendation: set the policy your mail team wants."
  value = concat(
    [for t in local.dkim_tokens : {
      name  = "${t}._domainkey.${var.domain}"
      type  = "CNAME"
      value = "${t}.dkim.amazonses.com"
    }],
    [
      { name = local.mail_from_domain, type = "MX", value = "10 feedback-smtp.${data.aws_region.current.name}.amazonses.com" },
      { name = local.mail_from_domain, type = "TXT", value = "v=spf1 include:amazonses.com ~all" },
      { name = "_dmarc.${var.domain}", type = "TXT", value = "v=DMARC1; p=quarantine; adkim=s; aspf=r" },
    ],
  )
}
