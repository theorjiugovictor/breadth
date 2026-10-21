variable "name" {
  type = string
}

variable "cidr" {
  type = string
}

variable "azs" {
  type = list(string)
}

resource "aws_vpc" "main" {
  cidr_block = var.cidr
  tags       = { Name = "${var.name}-vpc" }
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.cidr, 8, 1)
  availability_zone = var.azs[0]
  tags              = { Name = "${var.name}-private-a" }
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.cidr, 8, 2)
  availability_zone = var.azs[1]
  tags              = { Name = "${var.name}-private-b" }
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.cidr, 8, 10)
  availability_zone       = var.azs[0]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name}-public-a" }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name}-igw" }
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "private_subnet_ids" {
  value = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

output "public_subnet_ids" {
  value = [aws_subnet.public_a.id]
}
