/*
 * What the Tags tab shows: the inspector of the picked tag, the empty frame,
 * and the inline form that replaces the two prompts. An empty message is a
 * lightweight tag; typing one makes it annotated.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { GitTag, GitTagOrigin } from "../../../../shared/types.ts";
import { Button, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { TagIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { tagFormPlan, tagOriginChip } from "../../lib/gitG4.ts";
import { Aside, Fact, InspectorHead, NothingPicked, StateFrame } from "./HistoryFrames.tsx";
import { Chip, edge, wash } from "./ui.tsx";


export function TagInspector({ tag, origin }: { tag?: GitTag; origin?: GitTagOrigin }) {
  if (!tag) return <NothingPicked what="a tag" />;
  const chip = tagOriginChip(origin);
  return (
    <Aside>
      <InspectorHead icon={<TagIcon size={ICON.md} />} tone="--warning" title={tag.name}
        sub={[tag.annotated ? "annotated" : "lightweight", tag.date, tag.hash].join(" · ")} />
      {tag.annotated && tag.subject && (
        <div className="text-[11.5px] leading-relaxed px-3 py-2 rounded-lg" style={{ color: "var(--text2)", background: wash("--text", 5) }}>{tag.subject}</div>
      )}
      <div className="flex flex-col gap-1.5">
        {!tag.annotated && <Fact wide k="Points at" v={tag.subject} />}
        {chip && <Fact wide k="Remote" v={chip.label} />}
      </div>
    </Aside>
  );
}

export function NoTagsFrame() {
  return <StateFrame title="No tags yet" text="A tag is a name on a commit, usually a release. Leave the message empty for a lightweight tag." />;
}

export function TagOriginChip({ origin }: { origin?: GitTagOrigin }) {
  const c = tagOriginChip(origin);
  return c ? <Chip tone={c.tone}>{c.label}</Chip> : null;
}

/** The form that opens under the toolbar. It tags HEAD, as the old prompt did. */
export function TagForm({ head, existing, busy, onCreate, onCancel }: {
  head?: string; existing: readonly string[]; busy: boolean;
  onCreate: (name: string, message: string) => void; onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const plan = tagFormPlan(name, message, existing);
  const send = () => { if (plan.ok && !busy) onCreate(name.trim(), plan.message); };
  const row = (label: string, body: ReactNode) => (
    <label className="grid items-center gap-3" style={{ gridTemplateColumns: "4.5rem minmax(0,1fr)" }}>
      <span className="text-[11px]" style={{ color: "var(--text3)" }}>{label}</span>{body}
    </label>
  );
  const complaint = plan.reason && name.trim() ? plan.reason : "";
  return (
    <div className="flex flex-col gap-2 px-3 py-3 mb-3 rounded-xl" style={{ background: "var(--surface-card)", border: edge(10) }}
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
      {row("Name", <input ref={first} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }}
        placeholder="v1.3.0" className={`w-full min-w-0 ${INPUT}`} style={INPUT_STYLE} />)}
      {row("On", <span className={`w-full min-w-0 truncate ${INPUT}`} style={INPUT_STYLE}>HEAD{head ? ` · ${head}` : ""}</span>)}
      {row("Message", <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="Optional" className={`w-full min-w-0 resize-none ${INPUT}`} style={{ ...INPUT_STYLE, height: "auto" }} />)}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="min-w-0 flex-1 text-[11px]" style={{ color: complaint ? "var(--error-ink)" : "var(--text3)" }}>
          {complaint || <>Empty message: a <b>lightweight tag</b>, just a name on the commit. Type one to make it <b>annotated</b>.</>}
        </span>
        <Chip>{plan.annotated ? "annotated" : "lightweight"}</Chip>
        <Button onClick={onCancel}>Cancel</Button>
        <Button tone="primary" onClick={send} disabled={!plan.ok || busy} title={plan.reason || undefined}>
          <TagIcon size={ICON.sm} />{name.trim() ? `Create ${name.trim()}` : "Create"}
        </Button>
      </div>
    </div>
  );
}
