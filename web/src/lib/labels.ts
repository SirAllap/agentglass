import type { WatchEvent } from "../../../shared/types.ts";

// Plain-English verbs for each hook event — the friendly Mission-Control voice.
export interface Friendly {
  verb: string;
  color: string;
  dot: "live" | "run" | "warn" | "bad" | "idle";
}

export function friendly(e: WatchEvent): Friendly {
  switch (e.hook_event_type) {
    case "PreToolUse":
      return { verb: "Running a tool", color: "#a78bfa", dot: "run" };
    case "PostToolUse":
      return { verb: "Tool finished", color: "#34d399", dot: "live" };
    case "PostToolUseFailure":
      return { verb: "Tool failed", color: "#f87171", dot: "bad" };
    case "PermissionRequest":
      return { verb: "Needs your approval", color: "#fbbf24", dot: "warn" };
    case "Notification":
      return { verb: "Notification", color: "#fbbf24", dot: "warn" };
    // A GenAI record from an OTel source that carries no lifecycle meaning —
    // a heartbeat, a debug line, a vendor event the mapper has not learned.
    // Rendered as the ambient thing it is, never as attention.
    case "Telemetry":
      return { verb: "Telemetry", color: "#94a3b8", dot: "idle" };
    case "UserPromptSubmit":
      return { verb: "New prompt", color: "#c4b5fd", dot: "run" };
    case "SessionStart":
      return { verb: "Session started", color: "#34d399", dot: "live" };
    case "SessionEnd":
      return { verb: "Session ended", color: "#94a3b8", dot: "idle" };
    case "Stop":
      return { verb: "Turn complete", color: "#94a3b8", dot: "idle" };
    case "SubagentStart":
      return { verb: "Subagent started", color: "#a3e635", dot: "run" };
    case "SubagentStop":
      return { verb: "Subagent finished", color: "#84cc16", dot: "live" };
    case "PreCompact":
      return { verb: "Compacting memory", color: "#fb923c", dot: "warn" };
    default:
      return { verb: e.hook_event_type, color: "#94a3b8", dot: "idle" };
  }
}

// A short human summary of what the event was about (command / file / message).
export function detail(e: WatchEvent): string {
  const p = e.payload as any;
  if (e.tool_name === "Bash") {
    const cmd = p?.tool_input?.command;
    if (cmd) return String(cmd);
  }
  const path = p?.tool_input?.file_path || p?.tool_input?.path;
  if (path) return String(path);
  const q = p?.tool_input?.query || p?.tool_input?.pattern;
  if (q) return String(q);
  if (e.hook_event_type === "Notification") return String(p?.message ?? "");
  if (e.hook_event_type === "UserPromptSubmit") return String(p?.prompt ?? "");
  return e.tool_name ?? "";
}

export const DOT_COLOR: Record<Friendly["dot"], string> = {
  live: "#34d399",
  run: "#a78bfa",
  warn: "#fbbf24",
  bad: "#f87171",
  idle: "#64748b",
};
