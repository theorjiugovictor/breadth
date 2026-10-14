// Minimal POSIX path helpers so the code collector core runs in browsers as well as Node.

export function dirname(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return p.slice(0, i);
}

export function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t.slice(t.lastIndexOf("/") + 1);
}

export function normalize(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
    } else out.push(part);
  }
  const joined = out.join("/");
  return abs ? `/${joined}` : joined || ".";
}

export function join(...parts: string[]): string {
  return normalize(parts.filter(Boolean).join("/"));
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i) : "";
}
