resource "aws_lb" "public" {
  name               = "${local.name}-public"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.lb.id]
  subnets            = module.network.public_subnet_ids
}

resource "aws_lb_target_group" "ingress" {
  name        = "${local.name}-ingress"
  port        = 30080
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = module.network.vpc_id
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ingress.arn
  }
}

resource "aws_autoscaling_attachment" "ingress" {
  autoscaling_group_name = aws_eks_node_group.default.resources[0].autoscaling_groups[0].name
  lb_target_group_arn    = aws_lb_target_group.ingress.arn
}
