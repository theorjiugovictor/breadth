// Generates plan.json, shaped like `terraform show -json tfplan` for the shop's AWS platform.
// Run: node examples/shop/infra/terraform/generate.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const R = (type, name, values, refs = {}) => ({ type, name, values, refs });

const network = [
  R("aws_vpc", "main", { cidr_block: "10.0.0.0/16", tags: { Name: "shop-vpc" } }),
  R("aws_subnet", "private_a", { cidr_block: "10.0.1.0/24", availability_zone: "eu-west-1a", tags: { Name: "shop-private-a" } }, { vpc_id: ["aws_vpc.main.id", "aws_vpc.main"] }),
  R("aws_subnet", "private_b", { cidr_block: "10.0.2.0/24", availability_zone: "eu-west-1b", tags: { Name: "shop-private-b" } }, { vpc_id: ["aws_vpc.main.id", "aws_vpc.main"] }),
  R("aws_subnet", "public_a", { cidr_block: "10.0.10.0/24", availability_zone: "eu-west-1a", map_public_ip_on_launch: true, tags: { Name: "shop-public-a" } }, { vpc_id: ["aws_vpc.main.id", "aws_vpc.main"] }),
  R("aws_internet_gateway", "igw", { tags: { Name: "shop-igw" } }, { vpc_id: ["aws_vpc.main.id", "aws_vpc.main"] }),
];

const root = [
  R("aws_security_group", "lb", { name: "shop-lb", description: "Public load balancer", ingress: [{ from_port: 443, to_port: 443, protocol: "tcp", cidr_blocks: ["0.0.0.0/0"] }] }, { vpc_id: ["module.network.vpc_id", "module.network"] }),
  R("aws_security_group", "nodes", { name: "shop-eks-nodes", description: "EKS worker nodes" }, { vpc_id: ["module.network.vpc_id", "module.network"] }),
  R("aws_security_group", "db", { name: "shop-db", description: "Postgres" }, { vpc_id: ["module.network.vpc_id", "module.network"] }),
  R("aws_security_group", "kafka", { name: "shop-kafka", description: "MSK brokers" }, { vpc_id: ["module.network.vpc_id", "module.network"] }),
  R("aws_security_group_rule", "lb_to_nodes", { type: "ingress", from_port: 30080, to_port: 30080, protocol: "tcp" }, { security_group_id: ["aws_security_group.nodes.id", "aws_security_group.nodes"], source_security_group_id: ["aws_security_group.lb.id", "aws_security_group.lb"] }),
  R("aws_security_group_rule", "nodes_to_db", { type: "ingress", from_port: 5432, to_port: 5432, protocol: "tcp" }, { security_group_id: ["aws_security_group.db.id", "aws_security_group.db"], source_security_group_id: ["aws_security_group.nodes.id", "aws_security_group.nodes"] }),
  R("aws_security_group_rule", "nodes_to_kafka", { type: "ingress", from_port: 9092, to_port: 9098, protocol: "tcp" }, { security_group_id: ["aws_security_group.kafka.id", "aws_security_group.kafka"], source_security_group_id: ["aws_security_group.nodes.id", "aws_security_group.nodes"] }),
  R("aws_lb", "public", { name: "shop-public", load_balancer_type: "application", internal: false }, { security_groups: ["aws_security_group.lb.id", "aws_security_group.lb"], subnets: ["module.network.public_subnet_ids", "module.network"] }),
  R("aws_lb_target_group", "ingress", { name: "shop-ingress", port: 30080, protocol: "HTTP", target_type: "instance" }, { vpc_id: ["module.network.vpc_id", "module.network"] }),
  R("aws_lb_listener", "https", { port: 443, protocol: "HTTPS" }, { load_balancer_arn: ["aws_lb.public.arn", "aws_lb.public"], "default_action.target_group_arn": ["aws_lb_target_group.ingress.arn", "aws_lb_target_group.ingress"] }),
  R("aws_eks_cluster", "shop", { name: "shop", version: "1.30" }, { "vpc_config.subnet_ids": ["module.network.private_subnet_ids", "module.network"], "vpc_config.security_group_ids": ["aws_security_group.nodes.id", "aws_security_group.nodes"] }),
  R("aws_eks_node_group", "default", { node_group_name: "default", instance_types: ["m6i.large"] }, { cluster_name: ["aws_eks_cluster.shop.name", "aws_eks_cluster.shop"] }),
  R("aws_autoscaling_attachment", "ingress", {}, { lb_target_group_arn: ["aws_lb_target_group.ingress.arn", "aws_lb_target_group.ingress"], autoscaling_group_name: ["aws_eks_node_group.default.resources", "aws_eks_node_group.default"] }),
  R("aws_db_instance", "orders", { identifier: "shop-orders", engine: "postgres", engine_version: "16.3", instance_class: "db.t4g.medium", allocated_storage: 50, db_name: "shop", multi_az: true }, { vpc_security_group_ids: ["aws_security_group.db.id", "aws_security_group.db"], db_subnet_group_name: ["aws_db_subnet_group.main.name", "aws_db_subnet_group.main"] }),
  R("aws_db_subnet_group", "main", { name: "shop-db" }, { subnet_ids: ["module.network.private_subnet_ids", "module.network"] }),
  R("aws_msk_cluster", "events", { cluster_name: "shop-events", kafka_version: "3.6.0", number_of_broker_nodes: 3 }, { "broker_node_group_info.security_groups": ["aws_security_group.kafka.id", "aws_security_group.kafka"], "broker_node_group_info.client_subnets": ["module.network.private_subnet_ids", "module.network"] }),
  R("aws_secretsmanager_secret", "stripe", { name: "shop/stripe-key" }),
];

const asPlanned = (list, prefix) =>
  list.map((r) => ({ address: `${prefix}${r.type}.${r.name}`, mode: "managed", type: r.type, name: r.name, provider_name: "registry.terraform.io/hashicorp/aws", values: r.values }));
const asConfig = (list) =>
  list.map((r) => ({
    address: `${r.type}.${r.name}`,
    mode: "managed",
    type: r.type,
    name: r.name,
    expressions: Object.fromEntries(Object.entries(r.refs).map(([k, refs]) => [k, { references: refs }])),
  }));

const plan = {
  format_version: "1.2",
  terraform_version: "1.9.5",
  planned_values: {
    root_module: {
      resources: asPlanned(root, ""),
      child_modules: [{ address: "module.network", resources: asPlanned(network, "module.network.") }],
    },
  },
  configuration: {
    root_module: {
      resources: asConfig(root),
      module_calls: { network: { source: "./modules/network", module: { resources: asConfig(network) } } },
    },
  },
};

const out = join(dirname(fileURLToPath(import.meta.url)), "plan.json");
writeFileSync(out, JSON.stringify(plan, null, 1) + "\n");
console.log(`wrote ${out}`);
