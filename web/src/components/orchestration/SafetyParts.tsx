import { useEffect, useState } from "react";
import { SettingRow, Toggle } from "../SettingRow.tsx";
import { Button, Chip, INPUT, INPUT_STYLE, Segmented } from "../workspace/Chrome.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { api } from "../../lib/api.ts";
import type { Envelope, Policy } from "../../../../shared/orchestration.ts";
import { denyLines, LIMIT_RANGE, SAFETY } from "./orchestrationCopy.ts";

/**
 * The pieces of Safety and limits that more than one section uses: the note a
 * refused save leaves under its control, the deny editor, one envelope's rows,
 * and one limit's stepper. They were private to the page that drew them; the
 * section of the Flow view draws the same rows, so they live here instead.
 */

/** The server's sentence, or a note, under the control that produced it. */
export function Note({ text }: { text: string | undefined }) {
  if (!text) return null;
  return <div role="alert" className="agx-settings-x pt-2 pb-3 text-[12px]" style={{ color: "var(--error-ink)" }}>{text}</div>;
}

/** A list of command prefixes a worker is also refused, with one field to add to it. */
function DenyList({ id, deny, disabled, onChange }: { id: string; deny: string[]; disabled: boolean; onChange: (d: string[]) => void }) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    if (!t || deny.includes(t)) { setText(""); return; }
    onChange([...deny, t]);
    setText("");
  };
  return (
    <div className="grid gap-2">
      {deny.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="list" aria-label="Also refused">
          {deny.map((d) => (
            <span key={d} role="listitem" className="inline-flex items-center gap-1.5">
              <code className="t-mono text-[11.5px] rounded-lg px-2 py-1" style={{ background: "var(--surface-inset)" }}>{d}</code>
              <Button label={`Stop refusing ${d}`} square size="compact" disabled={disabled} onClick={() => onChange(deny.filter((x) => x !== d))}><CloseIcon size={ICON.sm} /></Button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} value={text} spellCheck={false} placeholder="a command to refuse" aria-label="Add a command to refuse"
          disabled={disabled} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, width: 260 }} />
        <Button disabled={disabled || !text.trim()} onClick={add}>Add</Button>
      </div>
    </div>
  );
}

/**
 * The commands no worker may run, one prefix per line. The text is the person's
 * while they type (a trailing newline must survive), and the list is what the
 * lines make: trimmed, no blanks, no repeats. There is one box and no second
 * field: a line added by hand is a line like any other.
 */
export function DenyBox({ deny, disabled, onChange }: { deny: string[]; disabled: boolean; onChange: (d: string[]) => void }) {
  const [text, setText] = useState(deny.join("\n"));
  // A save, a project switch or a line added elsewhere brought a list the text does not make.
  useEffect(() => { if (denyLines(text).join("\n") !== deny.join("\n")) setText(deny.join("\n")); }, [deny]);
  // The card body has no side padding of its own (rows carry theirs), so this block takes the header's 18px.
  return (
    <div className="grid gap-2 agx-settings-x pt-2 pb-3.5">
      <textarea value={text} rows={3} spellCheck={false} disabled={disabled} aria-label="Also refused here: one command per line"
        className="agx-orch-ta t-mono" onChange={(e) => { setText(e.target.value); onChange(denyLines(e.target.value)); }} />
    </div>
  );
}

/** One group of the envelope: write, network, commit, and the extra refusals. Docker has its own switch: it is a grant of the machine, not a default. */
export function EnvelopeRows({ prefix, env, locked, noDeny, onChange }: {
  prefix: string; env: Envelope; locked: boolean;
  /** The refused commands are edited elsewhere on the page. */
  noDeny?: boolean; onChange: (e: Envelope) => void;
}) {
  // Without a prefix the label starts a sentence; with one it follows a colon.
  const L = (w: string) => (prefix ? `${prefix}${w}` : w.charAt(0).toUpperCase() + w.slice(1));
  return (
    <>
      <SettingRow label={L("write files")} hint={SAFETY.write}
        control={<Segmented label={L("write files")} value={env.write}
          options={[{ id: "none", label: "Nothing" }, { id: "worktree", label: "Its own copy" }]}
          onChange={(w) => { if (!locked) onChange({ ...env, write: w }); }} />} />
      <Toggle label={L("commit in its own copy")} hint={SAFETY.commit} disabled={locked}
        on={env.commit} onClick={() => onChange({ ...env, commit: !env.commit })} />
      <Toggle label={L("network")} hint={SAFETY.network} disabled={locked}
        on={env.network} onClick={() => onChange({ ...env, network: !env.network })} />
      {!noDeny && <SettingRow label={L("also refuse")} hint={SAFETY.deny}
        below={<DenyList id={`${prefix}deny`.replace(/\W+/g, "-")} deny={env.deny} disabled={locked} onChange={(deny) => onChange({ ...env, deny })} />} />}
    </>
  );
}

/** One limit's row: its name, one example, and the two presses that move it. */
export function StepRow({ k, value, locked, onStep }: { k: keyof Policy["limits"]; value: number; locked: boolean; onStep: (by: -1 | 1) => void }) {
  const r = LIMIT_RANGE[k];
  return (
    <SettingRow label={r.label} hint={r.hint}
      control={
        <span className="flex items-center gap-1 justify-self-end">
          <Button label={`Fewer: ${r.label}`} square disabled={locked || value <= r.min} onClick={() => onStep(-1)}>−</Button>
          <span className="text-[12px] tabular-nums text-center w-[42px]" style={{ color: "var(--text)" }}>{value}</span>
          <Button label={`More: ${r.label}`} square disabled={locked || value >= r.max} onClick={() => onStep(1)}>+</Button>
        </span>
      } />
  );
}

/** A number the server keeps; it saves on every press, so it stops while a save is in flight. */
export function CountStepper({ id, value, min, max, label, disabled, onChange }: { id: string; value: number; min: number; max: number; label: string; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <span className="agx-count" data-count={id}>
      <button type="button" aria-label={`Fewer ${label}`} disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>−</button>
      <span aria-live="polite">{value}</span>
      <button type="button" aria-label={`More ${label}`} disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>+</button>
    </span>
  );
}

/**
 * The Gate, as the person's own switch: everything that leaves the machine (a
 * push, a pull request, a merge) waits for their answer. Its own setting, read
 * and written on the page that shows it.
 */
export function GateRow() {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.hooksStatus().then((r) => { if (live) setOn(r.gate); }).catch(() => { if (live) setOn(null); });
    return () => { live = false; };
  }, []);
  const flip = async () => {
    if (on === null) return;
    const r = await api.hooksGate(!on).catch(() => null);
    if (r?.ok) { setOn(!on); setError(null); } else setError(r?.error ?? "the server did not answer");
  };
  return (
    <Toggle label="Gate: ask me before landing" hint={error ?? SAFETY.gate} on={on === true} disabled={on === null} onClick={() => void flip()} />
  );
}

/** A choice between a few things, as chips on a track: the panel's engine and model rows. */
export function PickRow<T extends string>({ label, value, options, disabled, onChange, ctl, focus }: {
  label: string; value: T | ""; options: readonly { id: T; label: string; title?: string; disabled?: boolean }[];
  disabled?: boolean; onChange: (v: T) => void;
  /** The row a menu named, so the panel can bring it to the eye. */
  ctl?: "engine" | "model"; focus?: boolean;
}) {
  return (
    <div className="agx-flow-ctl" data-ctl={ctl} data-focus={focus ? "" : undefined}>
      <span className="agx-flow-fk">{label}</span>
      <Segmented track label={label} value={value} onChange={onChange} disabled={disabled}
        options={options.map((o) => ({ id: o.id, label: o.label, title: o.title, disabled: o.disabled }))} />
    </div>
  );
}

/** "Ask when it runs", as the hand-off rule words it: a chip on the picker. */
export function AskChip({ on, disabled, onToggle, hint }: { on: boolean; disabled: boolean; onToggle: () => void; hint: string }) {
  return <Chip on={on} resting disabled={disabled} title={hint} onClick={onToggle}>Ask when it runs</Chip>;
}
