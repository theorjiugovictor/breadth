# The shop's AWS platform: one EKS cluster runs the four services (see ../k8s/shop.yaml),
# behind a public load balancer, with Postgres for orders and MSK (Kafka) for events.

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
  region = var.region
}

locals {
  name = "shop"
  tags = {
    Project     = "shop"
    Environment = var.environment
  }
}

module "network" {
  source = "./modules/network"

  name = local.name
  cidr = "10.0.0.0/16"
  azs  = ["${var.region}a", "${var.region}b"]
}
