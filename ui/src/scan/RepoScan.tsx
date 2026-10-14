import { useEffect, useRef, useState } from "react";
import { Logo } from "../components/TopBar";
import type { Loaded } from "../data";
import { parseRepoInput, repoLabel, type RepoRef } from "./github";
import type { ScanMessage } from "./scan.worker";

const PHASES: { id: string; label: string }[] = [
  { id: "list", label: "Listing files" },
  { id: "download", label: "Downloading" },
  { id: "parse", label: "Parsing" },
  { id: "insights", label: "Finding insights" },
];

/** Scans a public GitHub repo entirely in the browser (Web Worker + tree-sitter WASM). */
export function RepoScan({ input, onDone, onCancel }: { input: string; onDone: (l: Loaded) => void; onCancel: () => void }) {
  const repo = parseRepoInput(input);
  const [progress, setProgress] = useState<Extract<ScanMessage, { type: "progress" }>>({ type: "progress", phase: "list" });
  const [error, setError] = useState<string | undefined>(repo ? undefined : `"${input}" is not a GitHub repository. Use owner/repo or a github.com URL.`);
  const started = useRef(false);

  useEffect(() => {
    if (!repo || started.current) return;
    started.current = true;
    const worker = new Worker(new URL("./scan.worker.ts", import.meta.url), { type: "module" });
    const wasmBase = new URL("wasm/", document.baseURI).href;
    worker.onmessage = (e: MessageEvent<ScanMessage>) => {
      const m = e.data;
      if (m.type === "progress") setProgress(m);
      else if (m.type === "error") setError(m.message);
      else onDone({ graph: m.graph, name: repoLabel(repo), warnings: [], notice: m.note, origin: "repo" });
    };
    worker.onerror = (e) => setError(`Scan failed: ${e.message}`);
    worker.postMessage({ repo: repo as RepoRef, wasmBase });
    return () => worker.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const phaseIndex = PHASES.findIndex((p) => p.id === progress.phase);
  const pct = progress.total ? Math.round(((progress.done ?? 0) / progress.total) * 100) : undefined;

  return (
    <div className="center-screen">
      <div className="drop scan-card">
        <Logo />
        <h1>{error ? "Could not scan" : `Scanning ${repo ? repoLabel(repo) : ""}`}</h1>
        {error ? (
          <>
            <p style={{ color: "var(--err)" }}>{error}</p>
            <button className="btn primary" onClick={onCancel}>
              Try another repository
            </button>
          </>
        ) : (
          <>
            <ol className="scan-steps">
              {PHASES.map((p, i) => (
                <li key={p.id} className={i < phaseIndex ? "done" : i === phaseIndex ? "on" : ""}>
                  <span className="dot-step" />
                  {p.label}
                  {i === phaseIndex && progress.total ? (
                    <span className="scan-count">
                      {progress.done ?? 0} / {progress.total}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
            <div className="scan-bar">
              <div style={{ width: `${pct ?? (phaseIndex >= 3 ? 100 : 8)}%` }} />
            </div>
            <p className="empty-note" style={{ marginTop: 14 }}>
              Everything runs in this tab: files come straight from GitHub and are parsed here. Nothing is uploaded anywhere.
            </p>
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** A small "owner/repo" form, used on the empty screen. */
export function RepoForm({ onSubmit, autoFocus }: { onSubmit: (repo: string) => void; autoFocus?: boolean }) {
  const [value, setValue] = useState("");
  const valid = !!parseRepoInput(value);
  return (
    <form
      className="repo-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(value.trim());
      }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="github.com/owner/repo"
        aria-label="GitHub repository"
        autoFocus={autoFocus}
        spellCheck={false}
      />
      <button className="btn primary" disabled={!valid} type="submit">
        Scan
      </button>
    </form>
  );
}
