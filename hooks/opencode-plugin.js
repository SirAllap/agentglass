// agentglass opencode plugin
// Forwards opencode session events to the agentglass /ingest endpoint.
//
// Install:  python3 hooks/connect_opencode.py
// Manual:   cp hooks/opencode-plugin.js ~/.config/opencode/plugins/agentglass.js
//
// Env:
//   AGENTGLASS_SERVER        server base url (default http://localhost:4000)
//   AGENTGLASS_URL           deprecated alias for AGENTGLASS_SERVER
//   AGENTGLASS_ALLOW_REMOTE  set to 1 to allow a non-local server
//   AGENTGLASS_INTERNAL      set to skip (prevents re-ingestion loops)

export function normalizeServer(url) {
  return url.replace(/\/+$/, "");
}

export function resolveServer(env = process.env) {
  return normalizeServer(
    env.AGENTGLASS_SERVER || env.AGENTGLASS_URL || "http://localhost:4000",
  );
}

const SERVER = resolveServer();
const INGEST_PATH = "/ingest";

const DEFAULT_SESSION_RE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T/;
const MAX_TOOL_OUTPUT = 256 * 1024;

export function limitToolOutput(value) {
  if (typeof value !== "string" || value.length <= MAX_TOOL_OUTPUT) return value;
  return `${value.slice(0, MAX_TOOL_OUTPUT)}\n[output truncated by agentglass]`;
}

export function isAllowedServer(url, allowRemote = false) {
  if (allowRemote) return true;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function sessionNameFromInfo(info) {
  if (!info?.title || DEFAULT_SESSION_RE.test(info.title)) return undefined;
  return info.title;
}

async function postEvent(body) {
  if (!isAllowedServer(SERVER, process.env.AGENTGLASS_ALLOW_REMOTE === "1")) {
    return false;
  }
  try {
    const res = await fetch(`${SERVER}${INGEST_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sourceAppFromDir(dir) {
  if (!dir) return "opencode";
  const parts = dir.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "opencode";
}

function sessionIDFromProps(properties) {
  return typeof properties?.sessionID === "string" && properties.sessionID
    ? properties.sessionID
    : undefined;
}

function modelLabel(info) {
  if (!info) return undefined;
  const pid = info.model?.providerID || info.providerID;
  const mid = info.model?.modelID || info.modelID;
  if (pid && mid) return `${pid}/${mid}`;
  if (mid) return mid;
  return undefined;
}

function usageFromAssistant(info) {
  const t = info?.tokens;
  if (!t) return undefined;
  const usage = {
    input_tokens: t.input || 0,
    output_tokens: t.output || 0,
  };
  if (t.cache?.read) usage.cache_read_input_tokens = t.cache.read;
  if (t.cache?.write) usage.cache_creation_input_tokens = t.cache.write;
  if (usage.input_tokens + usage.output_tokens === 0) return undefined;
  return usage;
}

export const AgentGlassPlugin = async ({ directory, worktree }) => {
  if (process.env.AGENTGLASS_INTERNAL) return {};

  const sourceApp = sourceAppFromDir(worktree || directory);
  const childSessions = new Set();
  const pendingPreTool = new Map();
  const completedMessages = new Map();
  const completingMessages = new Set();
  const clearSession = (id) => {
    childSessions.delete(id);
    for (const [callID, pre] of pendingPreTool) if (pre.sessionID === id) pendingPreTool.delete(callID);
    for (const [messageID, sessionID] of completedMessages) if (sessionID === id) completedMessages.delete(messageID);
  };

  return {
    "chat.message": async ({ sessionID, agent, model }) => {
      if (sessionID && childSessions.has(sessionID)) return;

      const payload = { project_path: worktree || directory };
      if (directory) payload.cwd = directory;

      const body = {
        source_app: sourceApp,
        session_id: sessionID || "unknown",
        hook_event_type: "UserPromptSubmit",
        payload,
        model_name: model ? `${model.providerID}/${model.modelID}` : undefined,
      };
      await postEvent(body);
    },

    "tool.execute.before": async ({ tool, sessionID, callID }, output) => {
      if (sessionID && childSessions.has(sessionID)) return;

      pendingPreTool.set(callID, { timestamp: Date.now(), sessionID });

      const payload = {
        tool_name: tool,
        tool_use_id: callID,
        tool_input: output?.args,
      };
      if (worktree || directory) payload.project_path = worktree || directory;

      await postEvent({
        source_app: sourceApp,
        session_id: sessionID || "unknown",
        hook_event_type: "PreToolUse",
        payload,
      });
    },

    "tool.execute.after": async (
      { tool, sessionID, callID, args },
      output
    ) => {
      if (sessionID && childSessions.has(sessionID)) return;

      const pre = pendingPreTool.get(callID);
      pendingPreTool.delete(callID);

      const isError = output?.output == null && output?.metadata?.error != null;
      const payload = {
        tool_name: tool,
        tool_use_id: callID,
        tool_input: args,
      };
      if (output?.output != null) {
        payload.tool_response = { content: limitToolOutput(output.output) };
      }
      if (output?.title) payload.tool_title = output.title;
      if (pre) payload.duration_ms = Date.now() - pre.timestamp;
      if (worktree || directory) payload.project_path = worktree || directory;

      if (isError) {
        payload.error = output.metadata.error;
        payload.is_error = true;
      }

      await postEvent({
        source_app: sourceApp,
        session_id: sessionID || "unknown",
        hook_event_type: isError ? "PostToolUseFailure" : "PostToolUse",
        payload,
      });
    },

    event: async ({ event }) => {
      const type = event?.type;
      const props = event?.properties ?? {};
      const sessionID = sessionIDFromProps(props);
      const info = props.info;

      if (info?.id && info.parentID) {
        childSessions.add(info.id);
      }

      if (sessionID && childSessions.has(sessionID)) {
        const parentSessionID = info?.parentID;
        const agentPayload = {
          agent_id: sessionID,
          agent_type: "subagent",
        };
        if (parentSessionID) agentPayload.parent_session_id = parentSessionID;

        switch (type) {
          case "session.created":
            await postEvent({
              source_app: sourceApp,
              session_id: parentSessionID || sessionID,
              hook_event_type: "SubagentStart",
              payload: agentPayload,
              model_name: modelLabel(info),
            });
            break;
          case "session.idle":
            await postEvent({
              source_app: sourceApp,
              session_id: parentSessionID || sessionID,
              hook_event_type: "SubagentStop",
              payload: agentPayload,
            });
            break;
          case "session.deleted":
            clearSession(sessionID);
            break;
        }
        return;
      }

      const basePayload = {};
      if (worktree || directory) basePayload.project_path = worktree || directory;

      switch (type) {
        case "session.created":
          await postEvent({
            source_app: sourceApp,
            session_id: sessionID || info?.id || "unknown",
            hook_event_type: "SessionStart",
            payload: basePayload,
            model_name: modelLabel(info),
            session_name: sessionNameFromInfo(info),
          });
          break;

        case "message.updated": {
          if (!info || info.role !== "assistant") break;
          if (!info.finish && !info.time?.completed) break;
          if (info.id && (completedMessages.has(info.id) || completingMessages.has(info.id))) break;
          const completedSession = info.sessionID || sessionID;
          if (info.id) completingMessages.add(info.id);

          const usage = usageFromAssistant(info);
          const msgPayload = {
            ...basePayload,
            last_assistant_message: info.finish || undefined,
          };
          if (usage) msgPayload.usage = usage;
          if (info.cost != null) msgPayload.cost_usd = info.cost;

          const posted = await postEvent({
            source_app: sourceApp,
            session_id: info.sessionID || sessionID || "unknown",
            hook_event_type: "Notification",
            payload: msgPayload,
            model_name: info.modelID
              ? `${info.providerID || "unknown"}/${info.modelID}`
              : modelLabel(info),
            session_name: sessionNameFromInfo(info),
          });
          if (info.id) {
            completingMessages.delete(info.id);
            if (posted) {
              completedMessages.set(info.id, completedSession);
              if (completedMessages.size > 1000) completedMessages.delete(completedMessages.keys().next().value);
            }
          }
          break;
        }

        case "session.idle": {
          await postEvent({
            source_app: sourceApp,
            session_id: sessionID || "unknown",
            hook_event_type: "Stop",
            payload: basePayload,
            session_name: sessionNameFromInfo(info),
          });
          break;
        }

        case "session.deleted":
          if (sessionID) clearSession(sessionID);
          break;

        case "session.updated":
          await postEvent({
            source_app: sourceApp,
            session_id: sessionID || info?.id || "unknown",
            hook_event_type: "Notification",
            payload: basePayload,
            session_name: sessionNameFromInfo(info),
          });
          break;

        case "session.error": {
          const errPayload = { ...basePayload };
          if (props.error) errPayload.error_text = String(props.error);
          await postEvent({
            source_app: sourceApp,
            session_id: sessionID || "unknown",
            hook_event_type: "Notification",
            payload: errPayload,
          });
          break;
        }

        case "permission.asked":
          await postEvent({
            source_app: sourceApp,
            session_id: sessionID || "unknown",
            hook_event_type: "PermissionRequest",
            payload: basePayload,
          });
          break;

        case "session.compacted":
          await postEvent({
            source_app: sourceApp,
            session_id: sessionID || "unknown",
            hook_event_type: "PreCompact",
            payload: basePayload,
          });
          break;
      }
    },
  };
};
