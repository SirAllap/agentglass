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

const childSessions = new Set();

const DEFAULT_SESSION_RE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T/;

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

async function fetchLastAssistantUsage(client, sessionID) {
  if (!client || !sessionID) return undefined;
  try {
    const messages = await client.session.listMessages(sessionID);
    if (!Array.isArray(messages)) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return usageFromAssistant(msg);
      }
    }
  } catch {}
  return undefined;
}

export const AgentGlassPlugin = async ({ client, directory, worktree }) => {
  if (process.env.AGENTGLASS_INTERNAL) return {};

  const sourceApp = sourceAppFromDir(worktree || directory);
  const pendingPreTool = new Map();

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
        payload.tool_response = { content: output.output };
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
        const agentPayload = {
          agent_id: sessionID,
          agent_type: "subagent",
        };
        if (info?.parentID) agentPayload.parent_session_id = info.parentID;

        switch (type) {
          case "session.created":
            await postEvent({
              source_app: sourceApp,
              session_id: sessionID,
              hook_event_type: "SubagentStart",
              payload: agentPayload,
              model_name: modelLabel(info),
            });
            break;
          case "session.idle":
            await postEvent({
              source_app: sourceApp,
              session_id: sessionID,
              hook_event_type: "SubagentStop",
              payload: agentPayload,
            });
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

          const usage = usageFromAssistant(info);
          const msgPayload = {
            ...basePayload,
            last_assistant_message: info.finish || undefined,
          };
          if (usage) msgPayload.usage = usage;
          if (info.cost != null) msgPayload.cost_usd = info.cost;

          await postEvent({
            source_app: sourceApp,
            session_id: info.sessionID || sessionID || "unknown",
            hook_event_type: "Stop",
            payload: msgPayload,
            model_name: info.modelID
              ? `${info.providerID || "unknown"}/${info.modelID}`
              : modelLabel(info),
            session_name: sessionNameFromInfo(info),
          });
          break;
        }

        case "session.idle": {
          const usage = await fetchLastAssistantUsage(client, sessionID);
          const idlePayload = { ...basePayload };
          if (usage) idlePayload.usage = usage;

          await postEvent({
            source_app: sourceApp,
            session_id: sessionID || "unknown",
            hook_event_type: "Stop",
            payload: idlePayload,
            session_name: sessionNameFromInfo(info),
          });
          break;
        }

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
