# What each service may do in AWS, through EKS Pod Identity.

resource "aws_iam_role" "payments" {
  name               = "${local.name}-payments"
  assume_role_policy = data.aws_iam_policy_document.assume["pods.eks.amazonaws.com"].json
}

resource "aws_eks_pod_identity_association" "payments" {
  cluster_name    = aws_eks_cluster.shop.name
  namespace       = "shop"
  service_account = "payments"
  role_arn        = aws_iam_role.payments.arn
}

resource "aws_iam_role_policy" "payments" {
  name   = "payments"
  role   = aws_iam_role.payments.name
  policy = data.aws_iam_policy_document.payments.json
}

data "aws_iam_policy_document" "payments" {
  statement {
    sid       = "StripeKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.stripe.arn]
  }
}

resource "aws_iam_role" "orders" {
  name               = "${local.name}-orders"
  assume_role_policy = data.aws_iam_policy_document.assume["pods.eks.amazonaws.com"].json
}

resource "aws_eks_pod_identity_association" "orders" {
  cluster_name    = aws_eks_cluster.shop.name
  namespace       = "shop"
  service_account = "orders"
  role_arn        = aws_iam_role.orders.arn
}

resource "aws_iam_role_policy" "orders" {
  name = "orders-events"
  role = aws_iam_role.orders.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kafka-cluster:Connect", "kafka-cluster:WriteData", "kafka-cluster:DescribeTopic"]
      Resource = [aws_msk_cluster.events.arn]
    }]
  })
}
