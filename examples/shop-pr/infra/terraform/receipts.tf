# Refund receipts (PDFs) written by the payments service.

resource "aws_s3_bucket" "refund_receipts" {
  bucket = "${local.name}-refund-receipts"
  tags   = local.tags
}

resource "aws_iam_role_policy" "payments_receipts" {
  name = "payments-receipts"
  role = aws_iam_role.payments.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:*"]
      Resource = ["${aws_s3_bucket.refund_receipts.arn}/*", "*"]
    }]
  })
}
