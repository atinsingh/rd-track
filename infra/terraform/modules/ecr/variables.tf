variable "repositories" {
  description = "Repository names. The API image also runs the worker and migrations."
  type        = list(string)
  default     = ["rd-track-api", "rd-track-web"]
}

variable "keep_last_images" {
  description = "Images kept per repository; older ones expire. Rollback reach = this many deploys."
  type        = number
  default     = 30
}

variable "force_delete" {
  description = "Allow terraform destroy to delete repositories that still contain images."
  type        = bool
  default     = false
}
