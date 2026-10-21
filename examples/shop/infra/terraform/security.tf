resource "aws_security_group" "lb" {
  name        = "${local.name}-lb"
  description = "Public load balancer"
  vpc_id      = module.network.vpc_id

  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "nodes" {
  name        = "${local.name}-eks-nodes"
  description = "EKS worker nodes"
  vpc_id      = module.network.vpc_id
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "Postgres"
  vpc_id      = module.network.vpc_id
}

resource "aws_security_group" "kafka" {
  name        = "${local.name}-kafka"
  description = "MSK brokers"
  vpc_id      = module.network.vpc_id
}

resource "aws_security_group_rule" "lb_to_nodes" {
  type                     = "ingress"
  from_port                = 30080
  to_port                  = 30080
  protocol                 = "tcp"
  security_group_id        = aws_security_group.nodes.id
  source_security_group_id = aws_security_group.lb.id
}

resource "aws_security_group_rule" "nodes_to_db" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.db.id
  source_security_group_id = aws_security_group.nodes.id
}

resource "aws_security_group_rule" "nodes_to_kafka" {
  type                     = "ingress"
  from_port                = 9092
  to_port                  = 9098
  protocol                 = "tcp"
  security_group_id        = aws_security_group.kafka.id
  source_security_group_id = aws_security_group.nodes.id
}
