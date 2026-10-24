import { AgentCard, type LanternRow } from "../../LanternView.tsx";
import { PreviewBox, PreviewNote } from "./Frame.tsx";
import { watchLine } from "./logic.ts";

export interface LanternPreviewProps {
  /** Watch the agents and notify. */
  watch: boolean;
  /** How often it looks, minutes. */
  everyMin: number;
  /** How long the prompt cache stays warm, minutes: the "wake at least every" setting. */
  wakeMin: number;
}

const MIN = 60_000;
const demo = (now: number): LanternRow[] => [
  { name: "builder-1", from: "said", state: "waiting", doing: "Retry the upload queue", saidAt: now - 4 * MIN, branch: "fix/upload-retry", worktree: "/work/orbit-upload",
    needsYou: { kind: "permission", why: "Bash(make check)", since: now - 3 * MIN },
    facts: { model: "claude-sonnet-5-5", tools: 41, errors: 0, turns: 12, cost: 0.84, lastSeen: now - 3 * MIN, lastTool: { name: "Bash", what: "make check", at: now - 3 * MIN } },
    git: { dirty: 3, ahead: 1, at: now } },
  { name: "scout-2", from: "said", state: "working", doing: "Reading the reconnect code", saidAt: now - 1 * MIN, branch: "main", worktree: "/work/orbit",
    facts: { model: "claude-haiku-4-5", tools: 9, errors: 0, turns: 3, cost: 0.02, lastSeen: now - MIN, lastTool: { name: "Read", what: "src/net/reconnect.ts", at: now - MIN } } },
];

/** The Lantern's own cards on invented agents, with no frame: what a live window shows for this view. */
export function LanternDemo({ watch, everyMin, wakeMin }: LanternPreviewProps) {
  const now = Date.now();
  const rows = demo(now);
  return (
      <div data-preview="lantern" className="flex flex-col gap-2 min-w-0 rounded-lg p-3" style={{ background: "var(--bg)" }}>
        <div className="flex flex-wrap items-baseline gap-x-3 text-[12px]">
          <b style={{ color: "var(--error)" }}>1 agent needs you</b>
          <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>1 working</span>
          <span data-watch-line className="text-[10.5px]" style={{ color: "var(--text4)" }}>{watchLine(watch, everyMin)}</span>
        </div>
        {rows.map((r) => <AgentCard key={r.name} r={r} cacheTtlMs={wakeMin * MIN} />)}
      </div>
  );
}

/** The real Lantern card on invented agents: the line under the title and the cache clock follow the settings. */
export function LanternPreview(p: LanternPreviewProps) {
  return (
    <PreviewBox label="The Lantern">
      <LanternDemo {...p} />
      <PreviewNote>The Lantern's own cards on invented agents.</PreviewNote>
    </PreviewBox>
  );
}
