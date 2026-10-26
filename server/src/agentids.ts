// What a model id and a session id may look like before they are handed to a
// CLI as an argument.
//
// A model id, with the optional window suffix Claude Code uses to ask for the
// 1M context window: `claude-opus-4-8[1m]`. The suffix has to be allowed
// through rather than sanitised away, because stripping it silently downgraded
// the window a chat had asked for and the UI still measured against whatever
// the name implied.
//
// It buys less than it once did, and only in specific places. On the
// first-party API the Claude 5 family and Opus 4.7+ run at 1M unconditionally,
// so the suffix is a no-op there. It still decides the window behind an LLM
// gateway, on Bedrock / Vertex / Foundry, and for Opus 4.6 — which is why it
// survives here rather than being dropped now that `contextWindow.ts` knows
// the families outright.
//
// Exported because codex.ts validates the same two things for the same reason.
// The shapes happen to coincide rather than being made to: a Codex model id
// (`gpt-5.6-luna`) is already inside this alphabet, and a Codex thread id is a
// UUID, which SESSION_RE already accepts. If the two ever diverge, codex.ts
// grows its own pair rather than this one being widened to cover both.
export const MODEL_RE = /^[a-z0-9][a-z0-9.-]{2,48}(\[[a-z0-9]{1,8}\])?$/;
export const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,64}$/;
