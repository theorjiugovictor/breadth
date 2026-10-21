resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = module.network.private_subnet_ids
}

resource "aws_db_instance" "orders" {
  identifier             = "${local.name}-orders"
  engine                 = "postgres"
  engine_version         = "16.3"
  instance_class         = var.db_instance_class
  allocated_storage      = 50
  db_name                = "shop"
  multi_az               = true
  storage_encrypted      = true
  deletion_protection    = true
  vpc_security_group_ids = [aws_security_group.db.id]
  db_subnet_group_name   = aws_db_subnet_group.main.name
  tags                   = local.tags
}

resource "aws_msk_cluster" "events" {
  cluster_name           = "${local.name}-events"
  kafka_version          = "3.6.0"
  number_of_broker_nodes = 3

  broker_node_group_info {
    instance_type   = "kafka.m5.large"
    client_subnets  = module.network.private_subnet_ids
    security_groups = [aws_security_group.kafka.id]
  }
}

resource "aws_secretsmanager_secret" "stripe" {
  name = "${local.name}/stripe-key"
}

# Left over from an old invoicing feature: nothing uses them any more.
resource "aws_s3_bucket" "invoices_legacy" {
  bucket = "${local.name}-invoices-legacy"
  tags   = { Name = "${local.name}-invoices-legacy" }
}

resource "aws_sqs_queue" "invoice_jobs" {
  name                      = "${local.name}-invoice-jobs"
  message_retention_seconds = 345600
}
