import { edgeId, type EdgeKind, type FlowEdge, type FlowNode, type Port } from "@breadth/schema";
import { parseAllDocuments } from "yaml";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec?: Json;
  data?: Json;
  file: string;
}

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod"]);

/** Parse one YAML/JSON file into Kubernetes objects (multi-doc and `kind: List` aware). */
export function parseK8s(text: string, file: string): K8sObject[] {
  const out: K8sObject[] = [];
  let docs: unknown[];
  try {
    docs = parseAllDocuments(text).map((d) => d.toJSON());
  } catch {
    return out;
  }
  const push = (d: unknown) => {
    if (!d || typeof d !== "object") return;
    const o = d as Json;
    if (o.kind === "List" && Array.isArray(o.items)) return o.items.forEach(push);
    if (typeof o.apiVersion === "string" && typeof o.kind === "string" && o.metadata?.name) out.push({ ...(o as K8sObject), file });
  };
  docs.forEach(push);
  return out;
}

function podSpec(o: K8sObject): Json | undefined {
  if (o.kind === "Pod") return o.spec;
  if (o.kind === "CronJob") return o.spec?.jobTemplate?.spec?.template?.spec;
  return o.spec?.template?.spec;
}

function podLabels(o: K8sObject): Record<string, string> {
  if (o.kind === "Pod") return o.metadata.labels ?? {};
  if (o.kind === "CronJob") return o.spec?.jobTemplate?.spec?.template?.metadata?.labels ?? {};
  return o.spec?.template?.metadata?.labels ?? {};
}

function matches(selector: Record<string, string> | undefined, labels: Record<string, string>): boolean {
  if (!selector || !Object.keys(selector).length) return false;
  return Object.entries(selector).every(([k, v]) => labels[k] === v);
}

function selectorLabels(sel: Json | undefined): Record<string, string> | undefined {
  if (!sel) return undefined;
  if (sel.matchLabels) return sel.matchLabels;
  if (Object.values(sel).every((v) => typeof v === "string")) return sel as Record<string, string>;
  return undefined;
}

export function k8sGraph(objects: K8sObject[]): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes = new Map<string, FlowNode>();
  const edges = new Map<string, FlowEdge>();
  const clusterId = "k8s:cluster";
  nodes.set(clusterId, { id: clusterId, name: "kubernetes", kind: "system", layer: "infra", description: "Kubernetes manifests" });

  const ns = (o: K8sObject) => o.metadata.namespace ?? "default";
  const idOf = (o: { kind: string; metadata: { name: string; namespace?: string } }) => `k8s:${o.metadata.namespace ?? "default"}/${o.kind}/${o.metadata.name}`;
  const nsNode = (name: string) => {
    const id = `k8s:ns/${name}`;
    if (!nodes.has(id)) nodes.set(id, { id, name, kind: "module", layer: "infra", parent: clusterId, description: `Namespace ${name}`, metadata: { platform: "kubernetes", type: "Namespace" } });
    return id;
  };
  const addEdge = (kind: EdgeKind, from: string, to: string, extra: Partial<FlowEdge> = {}) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return;
    const id = edgeId(kind, { node: from }, { node: to });
    const cur = edges.get(id);
    if (cur) {
      if (extra.label && cur.label && !cur.label.includes(extra.label)) cur.label = `${cur.label}, ${extra.label}`;
      return;
    }
    edges.set(id, { id, from: { node: from }, to: { node: to }, kind, ...extra });
  };

  const workloads = objects.filter((o) => WORKLOADS.has(o.kind));
  for (const o of objects) {
    if (o.kind === "Namespace") {
      nsNode(o.metadata.name);
      continue;
    }
    const parent = nsNode(ns(o));
    const base = { id: idOf(o), name: o.metadata.name, parent, source: { file: o.file, resource_ref: `${o.apiVersion} ${o.kind} ${ns(o)}/${o.metadata.name}` } };
    if (WORKLOADS.has(o.kind)) {
      const spec = podSpec(o) ?? {};
      const containers: Json[] = spec.containers ?? [];
      const inputs: Port[] = containers.flatMap((c) => (c.ports ?? []).map((p: Json) => ({ name: p.name ?? String(p.containerPort), type: `${(p.protocol ?? "TCP").toLowerCase()}/${p.containerPort}` })));
      const app = o.metadata.labels?.app ?? podLabels(o).app ?? o.metadata.labels?.["app.kubernetes.io/name"] ?? podLabels(o)["app.kubernetes.io/name"];
      nodes.set(base.id, {
        ...base,
        kind: "service",
        layer: "infra",
        aliases: [...new Set([`service:${o.metadata.name}`, ...(app ? [`service:${app}`] : [])])],
        inputs: inputs.length ? inputs : undefined,
        metadata: compact({
          platform: "kubernetes",
          type: o.kind,
          image: containers.map((c) => c.image).filter(Boolean).join(", ") || undefined,
          replicas: o.spec?.replicas,
          namespace: ns(o),
          serviceAccount: spec.serviceAccountName ?? spec.serviceAccount,
        }),
      });
    } else if (o.kind === "Service") {
      const ports: Port[] = (o.spec?.ports ?? []).map((p: Json) => ({ name: p.name ?? String(p.port), type: `${(p.protocol ?? "TCP").toLowerCase()}/${p.port}` }));
      nodes.set(base.id, {
        ...base,
        kind: "network_endpoint",
        layer: "network",
        description: `${o.spec?.type ?? "ClusterIP"} service`,
        aliases: [`k8s-svc:${o.metadata.name}`],
        inputs: ports.length ? ports : undefined,
        metadata: compact({ platform: "kubernetes", type: "Service", serviceType: o.spec?.type ?? "ClusterIP", namespace: ns(o) }),
      });
    } else if (o.kind === "Ingress") {
      nodes.set(base.id, { ...base, kind: "network_endpoint", layer: "network", description: "Ingress", metadata: { platform: "kubernetes", type: "Ingress", namespace: ns(o) } });
    } else if (o.kind === "ConfigMap" || o.kind === "Secret") {
      nodes.set(base.id, {
        ...base,
        kind: "infra_resource",
        layer: "infra",
        // Secret values never leave the manifest: keys only.
        outputs: Object.keys(o.data ?? (o as Json).stringData ?? {}).slice(0, 20).map((k) => ({ name: k })),
        metadata: { platform: "kubernetes", type: o.kind, namespace: ns(o) },
      });
    } else if (o.kind === "PersistentVolumeClaim") {
      nodes.set(base.id, { ...base, kind: "datastore", layer: "infra", metadata: compact({ platform: "kubernetes", type: o.kind, size: o.spec?.resources?.requests?.storage }) });
    } else if (o.kind === "NetworkPolicy") {
      // rendered as edges below
    } else {
      nodes.set(base.id, { ...base, kind: "infra_resource", layer: "infra", metadata: { platform: "kubernetes", type: o.kind, namespace: ns(o) } });
    }
  }

  const services = objects.filter((o) => o.kind === "Service");
  // Service -> workloads it selects
  for (const s of services) {
    const sel = s.spec?.selector as Record<string, string> | undefined;
    for (const w of workloads) {
      if (ns(w) !== ns(s) || !matches(sel, podLabels(w))) continue;
      const label = (s.spec?.ports ?? []).map((p: Json) => `${p.port}→${p.targetPort ?? p.port}`).join(", ") || undefined;
      addEdge("network", idOf(s), idOf(w), { protocol: "tcp", label });
    }
  }
  // Ingress -> services
  for (const ing of objects.filter((o) => o.kind === "Ingress")) {
    for (const rule of ing.spec?.rules ?? []) {
      for (const p of rule.http?.paths ?? []) {
        const name = p.backend?.service?.name ?? p.backend?.serviceName;
        if (!name) continue;
        addEdge("network", idOf(ing), idOf({ kind: "Service", metadata: { name, namespace: ns(ing) } }), { protocol: "http", label: `${rule.host ?? ""}${p.path ?? "/"}` });
      }
    }
    const def = ing.spec?.defaultBackend?.service?.name;
    if (def) addEdge("network", idOf(ing), idOf({ kind: "Service", metadata: { name: def, namespace: ns(ing) } }), { protocol: "http", label: "default" });
  }
  // Workload -> ConfigMaps / Secrets / PVCs, and env URLs pointing at other services
  // Non-secret environment of each workload (literal values and ConfigMap data), to match the
  // names code reads from the environment ($RECEIPTS_BUCKET) with the resources they name.
  const configMaps = new Map(objects.filter((o) => o.kind === "ConfigMap").map((o) => [`${ns(o)}/${o.metadata.name}`, ((o as Json).data ?? {}) as Record<string, unknown>]));
  for (const w of workloads) {
    const spec = podSpec(w) ?? {};
    const refs = new Set<string>();
    const env: Record<string, string> = {};
    for (const c of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
      for (const ef of c.envFrom ?? []) {
        for (const [k, v] of Object.entries(configMaps.get(`${ns(w)}/${ef.configMapRef?.name}`) ?? {})) if (typeof v === "string") env[`${ef.prefix ?? ""}${k}`] = v;
      }
      for (const e of c.env ?? []) {
        if (typeof e.value === "string") env[e.name] = e.value;
        const key = e.valueFrom?.configMapKeyRef;
        const v = key && configMaps.get(`${ns(w)}/${key.name}`)?.[key.key];
        if (typeof v === "string") env[e.name] = v;
      }
      for (const ef of c.envFrom ?? []) {
        if (ef.configMapRef?.name) refs.add(`ConfigMap/${ef.configMapRef.name}`);
        if (ef.secretRef?.name) refs.add(`Secret/${ef.secretRef.name}`);
      }
      for (const e of c.env ?? []) {
        if (e.valueFrom?.configMapKeyRef?.name) refs.add(`ConfigMap/${e.valueFrom.configMapKeyRef.name}`);
        if (e.valueFrom?.secretKeyRef?.name) refs.add(`Secret/${e.valueFrom.secretKeyRef.name}`);
        if (typeof e.value === "string") {
          const host = e.value.match(/^(?:[a-z]+:\/\/)?([a-z0-9-]+)(?:\.[a-z0-9-]+)*(?::(\d+))?/i);
          const svc = host && services.find((s) => s.metadata.name === host[1] && ns(s) === ns(w));
          if (svc && /(url|host|addr|endpoint|uri|broker|server)/i.test(e.name)) {
            addEdge("network", idOf(w), idOf(svc), { protocol: e.value.split(":")[0].match(/^[a-z]+$/) ? e.value.split(":")[0] : "tcp", label: e.name });
          }
        }
      }
    }
    for (const v of spec.volumes ?? []) {
      if (v.configMap?.name) refs.add(`ConfigMap/${v.configMap.name}`);
      if (v.secret?.secretName) refs.add(`Secret/${v.secret.secretName}`);
      if (v.persistentVolumeClaim?.claimName) refs.add(`PersistentVolumeClaim/${v.persistentVolumeClaim.claimName}`);
    }
    for (const r of refs) {
      const [kind, name] = r.split("/");
      addEdge("depends_on", idOf(w), idOf({ kind, metadata: { name, namespace: ns(w) } }));
    }
    const node = nodes.get(idOf(w));
    if (node && Object.keys(env).length) node.metadata = { ...node.metadata, env };
  }
  // NetworkPolicy ingress rules -> network edges between selected workloads
  for (const np of objects.filter((o) => o.kind === "NetworkPolicy")) {
    const targets = workloads.filter((w) => ns(w) === ns(np) && matches(selectorLabels(np.spec?.podSelector), podLabels(w)));
    for (const rule of np.spec?.ingress ?? []) {
      const ports = (rule.ports ?? []).map((p: Json) => `${(p.protocol ?? "TCP").toLowerCase()}/${p.port}`).join(", ") || undefined;
      for (const from of rule.from ?? []) {
        const sel = selectorLabels(from.podSelector);
        const sources = workloads.filter((w) => ns(w) === ns(np) && matches(sel, podLabels(w)));
        for (const s of sources) for (const t of targets) addEdge("network", idOf(s), idOf(t), { protocol: "tcp", label: ports, metadata: { policy: np.metadata.name } });
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function compact(o: Record<string, unknown>) {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === "") delete o[k];
  return o;
}
