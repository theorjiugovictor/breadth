resource "aws_eks_cluster" "shop" {
  name     = local.name
  version  = "1.30"
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids         = module.network.private_subnet_ids
    security_group_ids = [aws_security_group.nodes.id]
  }
}

resource "aws_eks_node_group" "default" {
  cluster_name    = aws_eks_cluster.shop.name
  node_group_name = "default"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = module.network.private_subnet_ids
  instance_types  = ["m6i.large"]

  scaling_config {
    desired_size = 3
    min_size     = 2
    max_size     = 6
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${local.name}-eks-cluster"
  assume_role_policy = data.aws_iam_policy_document.assume["eks.amazonaws.com"].json
}

resource "aws_iam_role" "nodes" {
  name               = "${local.name}-eks-nodes"
  assume_role_policy = data.aws_iam_policy_document.assume["ec2.amazonaws.com"].json
}

data "aws_iam_policy_document" "assume" {
  for_each = toset(["eks.amazonaws.com", "ec2.amazonaws.com", "pods.eks.amazonaws.com"])
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = [each.value]
    }
  }
}
