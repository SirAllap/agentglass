import { useRef, useState } from "react";
import { AnchoredMenu } from "./AnchoredMenu.tsx";
import { MenuItem } from "./ContextMenu.tsx";
import { Button, INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";
import { TaskDialog } from "./tasks/TaskDialog.tsx";
import { useHandoffEngines, modesFor, engineTitle } from "../lib/handoffEngines.ts";
import type { SendOpts } from "../lib/sendOptions.ts";
import { HIT } from "../lib/iconSize.ts";
import { LAUNCH_MODE_LABEL } from "../../../shared/launchModes.ts";

/**
 * The "⋯" on a prompt row: three ways to change ONE run, none of which changes a
 * setting. "Send to terminal" itself is the row; this is what is different this
 * time.
 *
 *   Run with…                       the engine
 *   Permission mode for this run    the modes THAT engine has a flag for
 *   Edit prompt before sending      the text, then it goes
 *
 * Everything ends in a terminal; there is no chat to open.
 */
export function PromptOptions({ label, loadPrompt, onSend, onDone }: {
  /** Names the prompt for the button's accessible name. */
  label: string;
  /** The text the row would send, or null when it cannot be read. */
  loadPrompt: () => Promise<string | null>;
  onSend: (o: SendOpts) => void;
  /** Called when the menu is left, whichever way: lets a parent menu close with it. */
  onDone?: () => void;
}) {
  const box = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"root" | "engine" | "mode">("root");
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const e = useHandoffEngines();
  const close = () => { setOpen(false); setView("root"); };
  const send = (o: SendOpts) => { close(); setText(null); onDone?.(); onSend(o); };
  const modes = e ? modesFor(e, e.def) : [];
  return (
    <>
      <button ref={box} type="button" role="menuitem" aria-label={`Options for ${label}`} aria-haspopup="menu" aria-expanded={open} title="More ways to send it"
        onClick={(ev) => { ev.stopPropagation(); setOpen((v) => !v); }}
        className="inline-flex items-center justify-center rounded hover:bg-white/10 shrink-0"
        style={{ width: HIT, height: HIT, color: "var(--text3)" }}>
        <span className="text-[13px] leading-none">&#8943;</span>
      </button>
      {open && (
        <AnchoredMenu anchor={box} align="right" placeKey={view} onClose={close}>
          {view === "root" && <>
            <MenuItem onClick={() => setView("engine")}>Run with…</MenuItem>
            <MenuItem onClick={() => setView("mode")}>Permission mode for this run</MenuItem>
            <MenuItem onClick={() => {
              void loadPrompt().then((t) => { if (t === null) setErr("Could not read the prompt."); else { close(); setText(t); } });
            }}>Edit prompt before sending</MenuItem>
            {err && <div role="alert" className="px-2 py-1 text-[10.5px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
          </>}
          {view === "engine" && <>
            <MenuItem onClick={() => setView("root")}>‹ Run with…</MenuItem>
            {(e?.engines ?? []).map((p) => (
              <MenuItem key={p.id} onClick={() => send({ kind: p.id })}>{p.title}{p.id === e?.def ? " · default" : ""}</MenuItem>
            ))}
            {!e && <div className="px-2 py-1 text-[10.5px]" style={{ color: "var(--text3)" }}>Engines are not loaded.</div>}
          </>}
          {view === "mode" && <>
            <MenuItem onClick={() => setView("root")}>‹ Permission mode for this run</MenuItem>
            <MenuItem onClick={() => send({})}>My setting</MenuItem>
            {modes.map((m) => <MenuItem key={m} onClick={() => send({ mode: m })}>{LAUNCH_MODE_LABEL[m]}</MenuItem>)}
            {e && <div className="px-2 py-1 text-[10.5px]" style={{ color: "var(--text4)" }}>{engineTitle(e, e.def)}</div>}
          </>}
        </AnchoredMenu>
      )}
      {text !== null && (
        <TaskDialog title="Edit prompt before sending" width={640} onClose={() => setText(null)}
          footer={<>
            <Button onClick={() => setText(null)}>Cancel</Button>
            <Button tone="primary" disabled={!text.trim()} onClick={() => send({ prompt: text })}>Send to terminal</Button>
          </>}>
          <textarea autoFocus value={text} onChange={(ev) => setText(ev.target.value)} spellCheck={false} rows={14}
            aria-label="Prompt text" className={`w-full ${INPUT} font-mono`} style={{ ...INPUT_STYLE, minHeight: 240 }} />
        </TaskDialog>
      )}
    </>
  );
}
