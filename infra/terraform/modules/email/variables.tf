variable "name" {
  description = "Name prefix, e.g. rd-track-staging."
  type        = string
}

variable "domain" {
  description = "Domain verified in SES for sending, e.g. track.rounddigital.example."
  type        = string
}

variable "mail_from_subdomain" {
  description = "Custom MAIL FROM subdomain (SPF alignment), e.g. mail → mail.<domain>."
  type        = string
  default     = "mail"
}

variable "route53_zone_id" {
  description = "Hosted zone for the domain. When set, DKIM/MAIL FROM records are created; otherwise create them from the dns_records output."
  type        = string
  default     = null
}
