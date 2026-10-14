// noodles live: sends unsaved editor buffers to a local `noodles watch`, so the canvas
// follows edits before they are saved. Only talks to 127.0.0.1; does nothing when no
// `noodles watch` is running.
const vscode = require("vscode");

const DEBOUNCE_MS = 400;
const PROBE_MS = 10_000;

function activate(context) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "noodles.openCanvas";
  context.subscriptions.push(status);

  let up = false;
  let lastProbe = 0;
  const timers = new Map();
  /** Paths whose unsaved text the server currently holds. */
  const sent = new Set();

  const port = () => vscode.workspace.getConfiguration("noodles").get("port", 4321);
  const enabled = () => vscode.workspace.getConfiguration("noodles").get("streamUnsaved", true);
  const base = () => `http://127.0.0.1:${port()}`;

  async function probe() {
    lastProbe = Date.now();
    try {
      const res = await fetch(`${base()}/api/info`, { signal: AbortSignal.timeout(800) });
      const info = res.ok ? await res.json() : undefined;
      up = !!(info && info.live);
    } catch {
      up = false;
    }
    if (up) {
      status.text = "$(pulse) noodles";
      status.tooltip = "noodles watch is live: unsaved edits appear on the canvas. Click to open it.";
      status.show();
    } else {
      status.hide();
      sent.clear();
    }
    return up;
  }

  async function post(files) {
    if (!up && !(Date.now() - lastProbe > 3000 && (await probe()))) return;
    try {
      await fetch(`${base()}/api/buffers`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-noodles": "1" },
        body: JSON.stringify({ files }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      up = false;
    }
  }

  function push(doc) {
    if (doc.uri.scheme !== "file" || !enabled()) return;
    const file = doc.uri.fsPath;
    clearTimeout(timers.get(file));
    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file);
        if (doc.isClosed || !doc.isDirty) return clear(file);
        sent.add(file);
        post([{ path: file, text: doc.getText() }]);
      }, DEBOUNCE_MS),
    );
  }

  function clear(file) {
    clearTimeout(timers.get(file));
    timers.delete(file);
    if (!sent.delete(file)) return;
    post([{ path: file, text: null }]);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => e.contentChanges.length && push(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => clear(doc.uri.fsPath)),
    vscode.workspace.onDidCloseTextDocument((doc) => clear(doc.uri.fsPath)),
    vscode.commands.registerCommand("noodles.openCanvas", () => vscode.env.openExternal(vscode.Uri.parse(`${base()}/`))),
  );

  probe();
  const interval = setInterval(probe, PROBE_MS);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

function deactivate() {}

module.exports = { activate, deactivate };
