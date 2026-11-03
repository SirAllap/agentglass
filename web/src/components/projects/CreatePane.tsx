// Add › Clone from URL, and Add › New project: one pane with two faces.
//
// Both say where the project will land before anything runs, and say what is
// wrong with the input as it is typed — a name with a space needs no server
// call to be refused. A clone shows elapsed time (git reports no honest
// percentage through this route), keeps Cancel enabled so a hung remote never
// traps the dialog, and on failure quotes git's cause, not its last hint.
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { CAN_BROWSE_FOLDER, chooseFolder } from "../../lib/desktop.ts";
import { ICON } from "../../lib/iconSize.ts";
import { clock, cloneUrlError, nameError, targetPreview, tildify } from "../../lib/projectsPaths.ts";
import { Button, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { DoneIcon, FolderIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { RIcon } from "../remoteIcons.tsx";
import { Foot, HUE, Kbd, Status, PaneHead, StateCard, Why, wash } from "./ui.tsx";
import { FolderField } from "./FolderField.tsx";

type Phase = { t: "form" } | { t: "running"; since: number } | { t: "failed"; why: string; since: number } | { t: "cancelled"; at: string; target: string };

/** A server error that is about the destination, so the Into-folder field is the one marked. */
const aboutParent = (m: string) => /folder|exist|absolute|too broad/i.test(m) && !/already exists/i.test(m);

export function CreatePane({ kind, value, setValue, parent, setParent, busyElsewhere, onBack, onCreated }: {
  kind: "clone" | "new"; value: string; setValue: (v: string) => void; parent: string; setParent: (v: string) => void;
  busyElsewhere: boolean; onBack: () => void; onCreated: (path: string, parent: string, note?: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ t: "form" });
  const [now, setNow] = useState(Date.now());
  const token = useRef(0);
  const isClone = kind === "clone";
  useEffect(() => { setPhase({ t: "form" }); }, [kind]);
  // Leaving the pane ends the wait: an answer that lands later must not open a project nobody is looking at.
  useEffect(() => () => { token.current++; }, []);
  useEffect(() => {
    if (phase.t !== "running") return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [phase.t]);

  const urlBad = isClone ? cloneUrlError(value) : null;
  const nameBad = isClone ? null : nameError(value);
  const target = targetPreview(kind, value, parent);
  const typed = value.trim().length > 0;
  const inputBad = isClone ? !!urlBad : !!nameBad;
  const ready = typed && !inputBad && !!parent.trim();
  const running = phase.t === "running";

  const run = () => {
    if (!ready || running) return;
    const me = ++token.current;
    setPhase({ t: "running", since: Date.now() });
    setNow(Date.now());
    const call = isClone ? api.cloneProject(value.trim(), parent.trim()) : api.newProject(value.trim(), parent.trim());
    call.then((r) => {
      if (me !== token.current) return; // cancelled: the answer is for a step nobody is waiting on
      if (!r.ok || !r.path) { setPhase({ t: "failed", why: r.error || (isClone ? "Could not clone that repository" : "Could not create that project"), since: Date.now() }); return; }
      onCreated(r.path, parent.trim(), r.error);
    }).catch((e) => { if (me === token.current) setPhase({ t: "failed", why: String(e), since: Date.now() }); });
  };
  const cancel = () => {
    token.current++;
    const at = phase.t === "running" ? clock((Date.now() - phase.since) / 1000) : "0:00";
    setPhase({ t: "cancelled", at, target: target ?? "" });
  };
  const leave = () => { if (running) cancel(); onBack(); };
  const form = phase.t === "form" || phase.t === "failed";
  const why = phase.t === "failed" ? phase.why : "";
  const parentWrong = phase.t === "failed" && aboutParent(why);
  const title = isClone ? "Clone from URL" : "New project";

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <PaneHead title={running ? (isClone ? "Cloning…" : "Creating…") : phase.t === "cancelled" ? "Clone stopped" : title} onBack={leave} />
      <div className="flex-1 min-h-0 overflow-y-auto agx-scroll">
        {/* shortcut: no percentage or bar - the clone route answers once, when git exits, so the elapsed clock is the only honest signal; a bar needs a streamed progress route. */}
        {running && (
          <StateCard hue="primary" spin icon={<RIcon name="clone" size={ICON.lg} />} title={isClone ? "Cloning" : "Creating the project"} badge={<Status hue="primary">{clock((now - phase.since) / 1000)}</Status>}
            actions={<Button onClick={cancel}>Stop waiting</Button>}>
            <span className="font-mono text-[11px]">into {tildify(target ?? parent)}</span>
            <div className="mt-1.5" style={{ color: "var(--text3)" }}>{isClone ? "A big repository can take minutes. You can stop waiting at any time; nothing here is locked." : "Making the folder and running git init."}</div>
          </StateCard>
        )}
        {phase.t === "cancelled" && (
          <StateCard hue="muted" icon={<WarningIcon size={ICON.lg} />} title={`Stopped waiting at ${phase.at}`}
            actions={<><Button tone="primary" onClick={() => setPhase({ t: "form" })}>Start again</Button><Button onClick={onBack}>Back to list</Button></>}>
            Your list is unchanged. If git finishes on its own, the folder is at <span className="font-mono text-[11px]">{tildify(phase.target || parent)}</span>; delete it by hand if you do not want it.
          </StateCard>
        )}
        {phase.t === "failed" && (
          <StateCard hue="error" icon={<WarningIcon size={ICON.lg} />} title={isClone ? "Clone failed" : "Could not create the project"} badge={<Status hue="error">no change made</Status>}
            actions={<Button tone="primary" onClick={run}>Retry</Button>}>
            {isClone ? <>git said: <span className="font-mono text-[11px]">{why}</span></> : why}
          </StateCard>
        )}
        {form && (
          <div className="pm-px grid gap-3 mt-1">
            <div className="grid gap-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text3)" }} htmlFor="create-input">{isClone ? "Repository URL" : "Name"}</label>
              <div className="relative flex items-center">
                <input id="create-input" autoFocus value={value} onChange={(e) => { setValue(e.target.value); if (phase.t === "failed") setPhase({ t: "form" }); }} spellCheck={false} autoComplete="off"
                  onKeyDown={(e) => { if (e.key === "Enter") run(); }} aria-invalid={inputBad} aria-describedby="create-help"
                  placeholder={isClone ? "https://github.com/acme/widget.git  ·  git@github.com:acme/widget.git" : "orbit-notifier"}
                  className={`w-full font-mono ${INPUT}`} style={{ ...INPUT_STYLE, ...(inputBad ? { borderColor: HUE.error, boxShadow: `0 0 0 3px ${wash(HUE.error, 10)}` } : typed ? { borderColor: HUE.success, boxShadow: `0 0 0 3px ${wash(HUE.success, 10)}` } : null), paddingRight: 34 }} />
                <span className="absolute right-2.5 inline-flex">{typed && (inputBad ? <span style={{ color: HUE.error }}><WarningIcon size={ICON.md} /></span> : <span style={{ color: HUE.success }}><DoneIcon size={ICON.md} /></span>)}</span>
              </div>
              <div id="create-help" role="status" className="text-[11.5px]" style={{ overflowWrap: "anywhere", color: inputBad ? "var(--error)" : "var(--text3)", minHeight: 16 }}>
                {urlBad || (nameBad && <>{nameBad.message}{nameBad.suggestion && <> Try <button className="font-mono bg-transparent border-0 p-0 cursor-pointer underline" style={{ color: "inherit" }} onClick={() => setValue(nameBad.suggestion)}>{nameBad.suggestion}</button>.</>}</>)
                  || (isClone ? "https://, ssh:// or git@host:path" : "Letters, digits, “-”, “_” and “.”")}
              </div>
            </div>
            <div className="grid gap-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text3)" }}>{isClone ? "Into folder" : "In folder"}</label>
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0"><FolderField label={isClone ? "Into folder" : "In folder"} value={parent} onChange={setParent} placeholder="~/code" tone={parentWrong ? "error" : undefined} describedBy="create-dest" /></div>
                {CAN_BROWSE_FOLDER && <Button onClick={() => void chooseFolder(parent || undefined).then((p) => p && setParent(p))}><FolderIcon size={ICON.xs} /> Change</Button>}
              </div>
              <div id="create-dest" className="text-[11.5px]" style={{ overflowWrap: "anywhere", color: parentWrong ? "var(--error)" : "var(--text3)", minHeight: 16 }}>
                {parentWrong ? <>That folder cannot be used: {why}</> : target ? <>Result: <span className="font-mono">{tildify(target)}</span></> : "The destination appears here once the input is valid."}
              </div>
            </div>
          </div>
        )}
      </div>
      <Foot hint={<><span><Kbd>Esc</Kbd> back</span><span><Kbd>⏎</Kbd> {isClone ? "clone" : "create"}</span></>}>
        <Button onClick={leave}>Cancel</Button>
        <Why reason={ready || running ? undefined : !typed ? (isClone ? "Paste a repository URL first" : "Type a name first") : inputBad ? "Fix the input above first" : "Choose a folder first"}>
          <Button tone="primary" pending={running} disabled={!ready || running || busyElsewhere} onClick={run} className="px-4">{isClone ? "Clone and open" : "Create and open"}</Button>
        </Why>
      </Foot>
    </div>
  );
}
