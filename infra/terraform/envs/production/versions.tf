terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state: one bucket per AWS account, created once by hand (runbook §1.2).
  # State contains the database passwords — keep the bucket private, versioned and
  # encrypted, and limit who can read it. Uncomment, fill, then `terraform init`.
  #
  # backend "s3" {
  #   bucket       = "rd-track-tfstate-<account-id>"
  #   key          = "production/terraform.tfstate"
  #   region       = "ca-central-1"
  #   encrypt      = true
  #   use_lockfile = true   # S3-native locking (Terraform >= 1.10); otherwise use dynamodb_table
  #   # dynamodb_table = "rd-track-tfstate-lock"
  # }
}

provider "aws" {
  region = var.region

  # Refuse to run against the wrong account (staging and production are separate accounts).
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project     = "rd-track"
      Environment = "production"
      ManagedBy   = "terraform"
      Repository  = "atinsingh/rd-track"
    }
  }
}
