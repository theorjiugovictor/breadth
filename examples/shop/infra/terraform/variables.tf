variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "db_instance_class" {
  type        = string
  description = "Size of the orders database"
  default     = "db.t4g.medium"
}
