variable "name" {
  description = "Name prefix, e.g. rd-track-staging. The role is <name>-github-deploy."
  type        = string
}

variable "github_repository" {
  description = "owner/repo allowed to assume the role."
  type        = string
  default     = "atinsingh/rd-track"
}

variable "github_environment" {
  description = "GitHub environment whose jobs may assume the role (OIDC sub repo:<repo>:environment:<env>)."
  type        = string
}

variable "create_oidc_provider" {
  description = "Create the account's token.actions.githubusercontent.com provider. Set false if it already exists (one per account)."
  type        = bool
  default     = true
}

variable "ecr_repository_arns" {
  description = "Repositories the pipeline pushes to."
  type        = list(string)
}

variable "cluster_arn" {
  description = "ECS cluster ARN."
  type        = string
}

variable "service_arns" {
  description = "ECS services the pipeline updates."
  type        = list(string)
}

variable "run_task_families" {
  description = "Task families the pipeline may run as one-off tasks (migrate)."
  type        = list(string)
}

variable "pass_role_arns" {
  description = "Execution and task roles referenced by the task definitions."
  type        = list(string)
}

variable "log_group_arns" {
  description = "Log groups the pipeline may read (to print migration output)."
  type        = list(string)
}
