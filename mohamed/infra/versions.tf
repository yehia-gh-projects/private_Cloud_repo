terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region                      = var.region
  access_key                  = var.access_key
  secret_key                  = var.secret_key
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true

  # On real AWS, delete this block and the three skip_* flags above.
  endpoints {
    acm                    = var.endpoint
    cloudwatch             = var.endpoint
    ec2                    = var.endpoint
    ecr                    = var.endpoint
    ecs                    = var.endpoint
    elb                    = var.endpoint
    elbv2                  = var.endpoint
    kms                    = var.endpoint
    secretsmanager         = var.endpoint
    iam                    = var.endpoint
    logs                   = var.endpoint
    ses                    = var.endpoint
    sesv2                  = var.endpoint
    sts                    = var.endpoint
    applicationautoscaling = var.endpoint
  }

  default_tags {
    tags = {
      Project = var.name
    }
  }
}
