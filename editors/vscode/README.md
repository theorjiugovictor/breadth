# noodles live

Companion to [`noodles watch`](https://github.com/theorjiugovictor/noodles#live-mode-watch-a-coding-agent).
It sends unsaved editor contents, from you or from a coding agent working in the editor (Copilot, Cursor, Windsurf, Antigravity), to the local `noodles watch` server. The live canvas then updates while code is being written, not only when it is saved.

- Talks only to `http://127.0.0.1:<noodles.port>` (default 4321), and only while `noodles watch` is running.
- A status bar item shows when it is connected. Click it to open the canvas.
- Turn it off with the `noodles.streamUnsaved` setting.

Install with `noodles editor install` (VS Code, Cursor, Windsurf, Antigravity), or `code --install-extension noodles-live.vsix`.
