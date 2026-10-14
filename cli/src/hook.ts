/** Map a coding agent's hook payload (Claude Code format, or a plain {files, prompt}) to an activity event. */
export function hookPayload(raw: Record<string, unknown>, agent?: string) {
  const input = (raw.tool_input ?? {}) as Record<string, unknown>;
  const files = [input.file_path, input.notebook_path, input.path, ...(Array.isArray(raw.files) ? raw.files : [])].filter((f): f is string => typeof f === "string");
  return {
    agent: agent ?? (typeof raw.agent === "string" ? raw.agent : raw.hook_event_name ? "Claude Code" : "agent"),
    event: (raw.hook_event_name ?? raw.event) as string | undefined,
    tool: (raw.tool_name ?? raw.tool) as string | undefined,
    files,
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    session: (raw.session_id ?? raw.session) as string | undefined,
  };
}

export const HOOK_CONFIG = {
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "noodles hook" }] }],
    PostToolUse: [{ matcher: "Edit|MultiEdit|Write|NotebookEdit", hooks: [{ type: "command", command: "noodles hook" }] }],
  },
};
