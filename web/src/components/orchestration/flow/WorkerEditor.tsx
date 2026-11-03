/*
 * The one worker editor: the same dialog for a role on the path, a role only in
 * the team, and a role that does not exist yet. It replaces the old side
 * panel's settings and the "Role and prompt" sheet, in the mockup's eight
 * sections in the mockup's order. "Add worker" opens it in new mode, and its
 * "Start from a team role" fills the draft from a role the team already has.
 * Nothing is deeper than two levels: rules open in their own sheet from the
 * section, and a chain is a row, never a fourth level.
 *
 * What saves when: engine, model, fallbacks, Ask and the reviewing block's three
 * settings save through their own controls as they change; the text fields, the
 * tools, Required and the failing arrow wait for Save role / Add worker. The
 * footer says which is which.
 *
 * Its ceiling, stated: a role of a person's own cannot be made a built-in or a
 * person's step here, and a role that is not on the path cannot be required.
 */
import { useEffect, useRef, useState } from "react";
import { FLOW_ICONS, FLOW_HUES, FLOW_PROMPT_MAX, roleById, type Flow, type FlowRole } from "../../../../../shared/flow.ts";
import { FLOW_ROUNDS_MAX } from "../../../../../shared/flow.ts";
import { DEFAULT_REVIEW_ROUNDS, REVIEW_ROUNDS_MAX } from "../../../../../shared/reviewSettings.ts";
import { templateFlow } from "../../../../../shared/flowTemplates.ts";
import { NEVER_LIFTABLE } from "../../../../../shared/workerRoles.ts";
import type { Chain } from "../../../../../shared/orchestration.ts";
import { ChainList } from "./ChainEditor.tsx";
import { BlockRules } from "./BlockRules.tsx";
import { ModelInput } from "./ModelInput.tsx";
import { PolicyRoleControls } from "./PolicyRoleControls.tsx";
import { WorkerCard } from "./WorkerCard.tsx";
import { ReviewerControls } from "./ReviewerControls.tsx";
import { Switch } from "./Switch.tsx";
import { FlowIcon } from "./flowIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { INPUT, INPUT_STYLE } from "../../workspace/Chrome.tsx";
import { removeFromPath } from "../../../lib/flowEdit.ts";
import { ENGINE_CHOICES, ENGINE_PLAN, TOOL_IDS, TOOL_WORD, engineName, passWord, shortChain, stageLabel } from "./flowScreenCopy.ts";
import { denyLines } from "../orchestrationCopy.ts";
import type { Around } from "./AroundFlow.tsx";
import { applyDraft, draftFromTeam, draftOf, freshDraft, REQUIRED_OFF_PATH, SECTIONS, showsReviewer, reviewerName, withFirstStep, type SectionId, type WorkerDraft } from "./workerDraft.ts";

export type WorkerEdit = { kind: "role"; id: string } | { kind: "new"; index: number };

/** A small (i) with the optional sentence in its tooltip, never a paragraph in the column. */
function Info({ text }: { text: string }) {
  return <span className="fe-inf" data-tip={text} tabIndex={0} aria-label={text}>i</span>;
}

/**
 * The commands a role may run, one prefix per line, in the shape of SafetyParts'
 * DenyBox. The text is the person's while they type (a trailing newline must
 * survive); the list is what the lines make, and the flow's validator answers a
 * prefix no role may ever be granted.
 */
function AllowBox({ allow, onChange }: { allow: string[]; onChange: (a: string[]) => void }) {
  const [text, setText] = useState(allow.join("\n"));
  useEffect(() => { if (denyLines(text).join("\n") !== allow.join("\n")) setText(allow.join("\n")); }, [allow]);
  return (
    <textarea id="fe-wed-allow" value={text} rows={2} spellCheck={false} aria-label="Commands this role may run, one prefix per line"
      placeholder="e.g. docker compose up" className="fe-in fe-wedallow"
      onChange={(e) => { setText(e.target.value); onChange(denyLines(e.target.value)); }} />
  );
}

/** The tool rows: the mockup's five tiles, each with the sentence that says what it lets through. */
const TOOL_SAYS: Record<string, string> = {
  read: "look at the tree", run: "test, build, grep", write: "only inside its worktree", commit: "never push", notes: "a handoff file",
};

/** The card the right column draws, built from the draft so it moves as the person types. */
function previewOf(flow: Flow, draft: WorkerDraft, role: FlowRole | null | undefined, onPath: boolean): Flow {
  const preview: FlowRole = {
    id: role?.id ?? "preview",
    name: draft.name.trim() || "New worker",
    does: draft.does.trim() || "One line about what it does.",
    prompt: draft.prompt,
    chain: draft.chain,
    tools: draft.tools,
    readsOnly: draft.readsOnly,
    required: draft.required && onPath,
    stage: draft.stage,
    ico: draft.ico,
    hue: draft.hue,
    allow: draft.allow,
    ...(role?.policyRole ? { policyRole: role.policyRole } : {}),
    ...(role?.actor ? { actor: role.actor } : {}),
  } as FlowRole;
  return { ...flow, roster: [...flow.roster.filter((r) => r.id !== preview.id), preview] };
}

export function WorkerEditor(p: {
  flow: Flow;
  edit: WorkerEdit;
  project: string;
  root: string;
  around: Around;
  onClose: () => void;
  onSave: (next: Flow, id: string) => void;
  /** The reviewer's cap is a project setting: it writes at once and says whether the server kept it. */
  onReviewRounds: (id: string, n: number) => Promise<boolean>;
  onRuleSaved?: () => void;
  /** "Who checks this" points at the reviewing block; this opens that role in the same editor. */
  onOpenRole: (id: string) => void;
}) {
  const isNew = p.edit.kind === "new";
  const role = p.edit.kind === "role" ? roleById(p.flow, p.edit.id) : null;
  const [draft, setDraft] = useState<WorkerDraft>(() => (role ? draftOf(p.flow, role) : freshDraft(p.flow)));
  // Which team role the new draft started from; the select in Prompt, empty while it is written here.
  const [from, setFrom] = useState("");
  const [index, setIndex] = useState(p.edit.kind === "new" ? p.edit.index : 0);
  const [teamOnly, setTeamOnly] = useState(false);
  const [error, setError] = useState("");
  const [section, setSection] = useState<SectionId>("who");
  const secRefs = useRef<Partial<Record<SectionId, HTMLElement | null>>>({});
  const shipped = role ? templateFlow().roster.find((r) => r.id === role.id) : undefined;

  // Escape belongs to a rule sheet open inside this one (RuleForm.tsx stops it); in the capture phase the editor closed first.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") p.onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [p]);

  if (p.edit.kind === "role" && !role) return null;

  const onPath = role ? p.flow.path.includes(role.id) : !teamOnly;
  const at = role ? p.flow.path.indexOf(role.id) : index;
  const person = role?.actor === "person";
  const earlier = onPath ? p.flow.path.slice(0, Math.max(0, at)) : [];
  const ownChain = !role || (!role.policyRole && !person);
  const reviewer = showsReviewer(role);
  const liveRounds = (role && p.flow.edges.find((e) => e.on === "fail" && e.from === role.id)?.maxRounds) || DEFAULT_REVIEW_ROUNDS;
  const offPath = isNew ? teamOnly : !onPath;
  const canSave = !!draft.name.trim() && !!draft.does.trim() && !!draft.prompt.trim();
  const set = (patch: Partial<WorkerDraft>) => setDraft((d) => ({ ...d, ...patch }));

  // The first step of a chain the flow owns: MAIN picks it, the ladder below only shows it.
  const first = draft.chain[0];
  const setEngine = (engine: string) =>
    set({ chain: withFirstStep(draft.chain, engine, engine === first?.engine ? first.model : (ENGINE_CHOICES.find((e) => e.id === engine)?.models[0] ?? "")) });
  const setModel = (model: string) => {
    if (first) set({ chain: withFirstStep(draft.chain, first.engine, model) });
  };

  const save = () => {
    const place = isNew ? (teamOnly ? { kind: "team" as const } : { kind: "path" as const, index }) : null;
    const r = applyDraft(p.flow, draft, place);
    if (!r.ok) { setError(r.error); return; }
    p.onSave(r.flow, r.id);
  };

  /** A copy of the role, off the path, made by the same code that adds any new role. */
  const duplicate = () => {
    const name = `${draft.name.trim()} copy`.slice(0, 60);
    const r = applyDraft(p.flow, { ...draft, id: "", name, required: false }, { kind: "team" });
    if (!r.ok) { setError(r.error); return; }
    p.onSave(r.flow, r.id);
  };

  const jump = (id: SectionId) => {
    setSection(id);
    secRefs.current[id]?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const sec = (id: SectionId, title: string, note: React.ReactNode, body: React.ReactNode) => (
    <section id={`fe-wed-${id}`} ref={(el) => { secRefs.current[id] = el; }} className="fe-sec" data-current={section === id ? "" : undefined}>
      <h3>{title} {note}</h3>
      {body}
    </section>
  );

  const where = (() => {
    const before = p.flow.path[index - 1], after = p.flow.path[index];
    return before && after ? `between ${roleById(p.flow, before)?.name} and ${roleById(p.flow, after)?.name}` : before ? `at the end, after ${roleById(p.flow, before)?.name}` : "at the start of the path";
  })();

  // The mockup's nav: a person's step has no tools, no rules and no reviewer, and only a new role is placed.
  const navSections = SECTIONS.filter((s) =>
    !(person && ["may", "rules", "check"].includes(s.id))
    && !(!isNew && s.id === "place")
    && !(isNew && s.id === "rules"));
  const prevId = onPath && role ? p.flow.path[(at - 1 + p.flow.path.length) % p.flow.path.length] : null;
  const nextId = onPath && role ? p.flow.path[(at + 1) % p.flow.path.length] : null;
  const edited = !!role && (role.prompt !== draft.prompt || role.name !== draft.name || role.does !== draft.does);
  const preview = previewOf(p.flow, draft, role, onPath);
  const previewRole = preview.roster[preview.roster.length - 1]!;

  return (
    <div className="fe-dialog" onPointerDown={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="fe-dlg fe-wed" role="dialog" aria-modal="true" aria-labelledby="fe-wed-title">
        <div className="fe-eh">
          <span className="fe-tile" style={{ background: `var(--${draft.hue})` }} aria-hidden="true"><FlowIcon name={draft.ico} size={20} /></span>
          <div>
            <b className="fe-ehtitle" id="fe-wed-title">{role ? role.name : draft.name.trim() || "New worker"}</b>
            <div className="fe-ehsub">{role
              ? `${stageLabel(p.flow, role.stage)} · ${onPath ? `block ${at + 1} of ${p.flow.path.length}` : "in the team"} · one role, used wherever the orchestrator picks it`
              : "Nothing exists until you press Add worker · same sections as any worker"}</div>
          </div>
          <span className="fe-sp" />
          {!isNew && (
            <>
              <button className="fe-btn" data-size="sm" data-tone="quiet" data-prev type="button" title="Previous role" aria-label="Previous role"
                disabled={!prevId} onClick={() => prevId && p.onOpenRole(prevId)}><FlowIcon name="back" size={14} /></button>
              <button className="fe-btn" data-size="sm" data-tone="quiet" data-prev type="button" title="Next role" aria-label="Next role" style={{ transform: "scaleX(-1)" }}
                disabled={!nextId} onClick={() => nextId && p.onOpenRole(nextId)}><FlowIcon name="back" size={14} /></button>
            </>
          )}
          <button className="fe-btn" data-size="sm" data-tone="quiet" data-close type="button" title="Close" aria-label="Close" onClick={p.onClose}><FlowIcon name="x" size={14} /></button>
        </div>

        <div className="fe-wedbody">
          <nav className="fe-wednav" aria-label="Sections">
            {navSections.map((s) => (
              <button key={s.id} type="button" data-sec={s.id} aria-current={section === s.id} onClick={() => jump(s.id)}><FlowIcon name={s.icon} size={14} /><span>{s.label}</span></button>
            ))}
            {!isNew && (
              <>
                <hr />
                <button type="button" data-act="dup" onClick={duplicate}><FlowIcon name="copy" size={14} /><span>Duplicate role</span></button>
                {onPath && (
                  <button type="button" data-act="rm" className="fe-danger" onClick={() => p.onSave(removeFromPath(p.flow, role!.id), role!.id)}><FlowIcon name="x" size={14} /><span>Remove from path</span></button>
                )}
              </>
            )}
          </nav>

          <div className="fe-wedscroll fe-wedmain">
            {error && <p className="fe-errline" role="alert">{error}</p>}

            {navSections[0]?.id === "id" && (
              <section id="fe-wed-id" ref={(el) => { secRefs.current.id = el; }} className="fe-sec" data-current={section === "id" ? "" : undefined}>
                {isNew ? (
                  <>
                    <h3>Name and look <small>saved with “Add worker”</small></h3>
                    <div className="fe-picker">
                      <span className="fe-pvtile" style={{ background: `var(--${draft.hue})` }} aria-hidden="true"><FlowIcon name={draft.ico} size={30} /></span>
                      <div className="fe-pg2">
                        <div className="fe-exits fe-exits2">
                          <div><div className="fe-lab">Role name</div><input className={`${INPUT} fe-in`} id="fe-wed-name" value={draft.name} maxLength={60} spellCheck={false} placeholder="e.g. Security" onChange={(e) => set({ name: e.target.value })} /></div>
                          <div><div className="fe-lab">Stage <Info text="The stage of the flow this block belongs to: the headings of the Flow board." /></div>
                            <span className="fe-selwrap"><select id="fe-wed-stage" value={draft.stage} onChange={(e) => set({ stage: e.target.value })}>{p.flow.stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select><FlowIcon name="chev" size={12} /></span>
                          </div>
                        </div>
                        <div><div className="fe-lab">Icon <small>{FLOW_ICONS.length} to pick from</small></div>
                          <div className="fe-pico">{FLOW_ICONS.map((n) => (
                            <button key={n} type="button" aria-pressed={draft.ico === n} title={n} aria-label={n} onClick={() => set({ ico: n })}><FlowIcon name={n} size={18} /></button>
                          ))}</div>
                        </div>
                        <div><div className="fe-lab">Colour</div>
                          <div className="fe-pcol">{FLOW_HUES.map((h) => (
                            <button key={h} type="button" aria-pressed={draft.hue === h} title={h} aria-label={h} style={{ background: `var(--${h})` }} onClick={() => set({ hue: h })} />
                          ))}</div>
                        </div>
                      </div>
                    </div>
                    <div><div className="fe-lab">One line: what it does</div>
                      <input className={`${INPUT} fe-in`} id="fe-wed-does" value={draft.does} maxLength={200} spellCheck={false} placeholder="Looks for what could be abused" onChange={(e) => set({ does: e.target.value })} />
                    </div>
                  </>
                ) : (
                  <details className="fe-nl" open={false} onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) setSection("id"); }}>
                    <summary>
                      <span className="fe-tile fe-sm" style={{ background: `var(--${draft.hue})` }} aria-hidden="true"><FlowIcon name={draft.ico} size={18} /></span>
                      <span className="fe-nls"><b>{draft.name}</b><small>{stageLabel(p.flow, draft.stage)} · {draft.does}</small></span>
                      <span className="fe-nle">Rename, icon, colour <i>▾</i></span>
                    </summary>
                    <div className="fe-two">
                      <div className="fe-field">
                        <label htmlFor="fe-wed-name">Role name</label>
                        <input className={`${INPUT} w-full`} style={INPUT_STYLE} id="fe-wed-name" value={draft.name} maxLength={60} spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
                      </div>
                      <div className="fe-field">
                        <label htmlFor="fe-wed-stage">Stage</label>
                        <span className="fe-selwrap"><select id="fe-wed-stage" value={draft.stage} onChange={(e) => set({ stage: e.target.value })}>{p.flow.stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select><FlowIcon name="chev" size={12} /></span>
                      </div>
                    </div>
                    <div className="fe-field">
                      <label htmlFor="fe-wed-does">One line: what it does</label>
                      <input className={`${INPUT} w-full`} style={INPUT_STYLE} id="fe-wed-does" value={draft.does} maxLength={200} spellCheck={false} placeholder="Runs the change in the built app and attaches what broke." onChange={(e) => set({ does: e.target.value })} />
                    </div>
                    <div className="fe-field">
                      <span className="fe-flabel">Icon</span>
                      <div className="fe-wedicons">
                        {FLOW_ICONS.map((n) => (
                          <button key={n} type="button" className="fe-sq" aria-pressed={draft.ico === n} aria-label={n} title={n}
                            onClick={() => set({ ico: n })}><FlowIcon name={n} size={ICON.sm} /></button>
                        ))}
                      </div>
                    </div>
                    <div className="fe-field">
                      <span className="fe-flabel">Colour</span>
                      <div className="fe-wedhues">
                        {FLOW_HUES.map((h) => (
                          <button key={h} type="button" className="fe-wedhue" aria-pressed={draft.hue === h} aria-label={h} title={h} style={{ "--hue": `var(--${h})` } as React.CSSProperties}
                            onClick={() => set({ hue: h })}><i /></button>
                        ))}
                      </div>
                    </div>
                  </details>
                )}
              </section>
            )}

            {sec("who", "Who does the work", <small>{isNew ? "saved with “Add worker”" : role?.policyRole ? "saves at once" : "saved with “Save role”"}</small>, role?.policyRole
              ? <PolicyRoleControls role={role.policyRole} name={role.name} />
              : person
                ? <p className="fe-wedquiet">A person answers this step. Nothing runs here.</p>
                : ownChain
                  ? (
                    <>
                      <div><div className="fe-lab">Engine</div>
                        <div className="fe-eng">
                          {ENGINE_CHOICES.map((e) => (
                            <button key={e.id} type="button" aria-pressed={first?.engine === e.id} onClick={() => setEngine(e.id)}>
                              <b>{engineName(e.id)}</b><small>{ENGINE_PLAN[e.id]}</small>
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="fe-field">
                        <ModelInput choice={first ?? null} label={`Model for ${draft.name || "this role"}`} disabled={!first}
                          note={`${(ENGINE_CHOICES.find((e) => e.id === first?.engine)?.models ?? []).length} offered · its own default if you pick none`}
                          wide onCommit={(c) => setModel(c.model)} />
                      </div>
                      <div className="fe-fbsec">
                        <span className="fe-lab">If it cannot start, try next <small>in this order · drag to reorder</small></span>
                        <ChainList chain={draft.chain} onChange={(chain: Chain) => set({ chain })} />
                      </div>
                    </>
                  )
                  : <p className="fe-wedquiet">{shortChain(draft.chain)}</p>)}

            {sec("prompt", person ? "Role" : "Prompt", <small>{isNew ? "saved with “Add worker”" : "saved with “Save role”"}</small>, person ? (
              <div className="fe-exits fe-exits2">
                <div><div className="fe-lab">Role name</div><input className={`${INPUT} fe-in`} value={draft.name} readOnly /></div>
                <div><div className="fe-lab">One line: what it does</div><input className={`${INPUT} fe-in`} value={draft.does} readOnly /></div>
              </div>
            ) : (
              <>
                {isNew && (
                  <div>
                    <div className="fe-lab">Start from a team role <small>optional · fills the prompt and the tools</small></div>
                    <span className="fe-selwrap">
                      <select id="fe-wed-from" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value) setDraft((d) => draftFromTeam(p.flow, e.target.value, d)); }}>
                        <option value="">Nothing: write my own</option>
                        {p.flow.roster.filter((r) => !p.flow.path.includes(r.id)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                      <FlowIcon name="chev" size={12} />
                    </span>
                  </div>
                )}
                <textarea className="fe-ta" id="fe-wed-prompt" aria-label="Prompt" value={draft.prompt} maxLength={FLOW_PROMPT_MAX} spellCheck={false}
                  onChange={(e) => set({ prompt: e.target.value })} />
                <div className="fe-promptfoot">
                  <span>the turn starts with this</span>
                  <span className="fe-sp" />
                  <span>{draft.prompt.length} / {FLOW_PROMPT_MAX} · kept for {p.project}</span>
                </div>
                {!isNew && (
                  <div className="fe-rolemask">
                    <FlowIcon name="spark" size={12} />
                    <span>{shipped ? <>agentglass ships this role: <b>{shipped.name}</b></> : <>Template: <b>your own</b></>}</span>
                    <span className="fe-sp" />
                    {shipped && (
                      <>
                        <span className="fe-badge" data-tone={shipped.prompt !== draft.prompt || shipped.does !== draft.does || shipped.name !== draft.name ? "warn" : "off"}><i />{shipped.prompt !== draft.prompt || shipped.does !== draft.does || shipped.name !== draft.name ? "Edited" : "As shipped"}</span>
                        <button className="fe-btn" data-size="sm" type="button" disabled={shipped.prompt === draft.prompt && shipped.does === draft.does && shipped.name === draft.name}
                          onClick={() => set({ name: shipped.name, does: shipped.does, prompt: shipped.prompt })}><FlowIcon name="undo" size={ICON.xs} />Reset to default</button>
                      </>
                    )}
                  </div>
                )}
              </>
            ))}

            {sec("place", "Where it goes", null,
              <>
                <div className="fe-seg" role="group" aria-label="Where it goes">
                  <button type="button" aria-pressed={!teamOnly} onClick={() => setTeamOnly(false)}>On the path</button>
                  <button type="button" aria-pressed={teamOnly} onClick={() => setTeamOnly(true)}>Only in the team</button>
                </div>
                {!teamOnly && (
                  <div className="fe-exits fe-exits2">
                    <div><div className="fe-lab">After</div>
                      <span className="fe-selwrap"><select id="fe-wed-after" value={index} onChange={(e) => setIndex(Number(e.target.value))}>
                        {p.flow.path.map((id, i) => <option key={id} value={i + 1}>{roleById(p.flow, id)?.name}</option>)}
                        <option value={0}>The start of the path</option>
                      </select><FlowIcon name="chev" size={12} /></span>
                      <small>It goes {where}.</small>
                    </div>
                    <div><div className="fe-lab">Before</div><input className={`${INPUT} fe-in`} value={p.flow.path[index] ? roleById(p.flow, p.flow.path[index]!)?.name ?? "" : "the end"} readOnly disabled /></div>
                  </div>
                )}
                <p className="fe-note">“Only in the team” keeps it ready in the rail with no place on the path; drag it onto the canvas later. The orchestrator can still pick it when a rule says so.</p>
              </>)}

            {sec("path", "What happens next", null, person ? (
              <p className="fe-wedquiet">A person's step waits for you and nothing runs: it has no exits of its own.</p>
            ) : (
              <>
                <div className="fe-exits">
                  <div><div className="fe-lab">If it passes</div><input className={`${INPUT} fe-in`} value={isNew ? (p.flow.path[index] ? roleById(p.flow, p.flow.path[index]!)?.name ?? "the end" : "the end") : onPath ? passWord(p.flow, role?.id ?? "") : "nothing until it is on the path"} readOnly disabled /></div>
                  {onPath && (
                    <div className="fe-field">
                      <label htmlFor="fe-wed-fail">If it fails</label>
                      <span className="fe-selwrap"><select id="fe-wed-fail" value={draft.failTo} onChange={(e) => set({ failTo: e.target.value })}>
                        <option value="">Asks you</option>
                        {earlier.map((id) => <option key={id} value={id}>Back to {stageLabel(p.flow, roleById(p.flow, id)?.stage ?? "")} ({roleById(p.flow, id)?.name})</option>)}
                      </select><FlowIcon name="chev" size={12} /></span>
                    </div>
                  )}
                  {onPath && !reviewer && (
                    <div className="fe-field">
                      <span className="fe-flabel">Rounds before it asks you</span>
                      <span className="fe-stepper">
                        <button type="button" aria-label="Fewer rounds" disabled={!draft.failTo || draft.rounds <= 1} onClick={() => set({ rounds: draft.rounds - 1 })}><FlowIcon name="minus" size={ICON.xs} /></button>
                        <span>{draft.failTo ? draft.rounds : "—"}</span>
                        <button type="button" aria-label="More rounds" disabled={!draft.failTo || draft.rounds >= FLOW_ROUNDS_MAX} onClick={() => set({ rounds: draft.rounds + 1 })}><FlowIcon name="plus" size={ICON.xs} /></button>
                        <small>rounds</small>
                      </span>
                    </div>
                  )}
                </div>
                <div className="fe-row2">
                  <div className="fe-d"><b>Required</b><small>The orchestrator is told this one cannot be skipped. Enforced by the server: nothing lands without a passing result.</small></div>
                  <Switch on={draft.required && !offPath} label="Required" disabled={offPath} onChange={(on) => set({ required: on })} />
                </div>
                {offPath && <p className="fe-wedquiet">{REQUIRED_OFF_PATH}</p>}
              </>
            ))}

            {sec("may", "What it may do", null,
              <>
                <div className="fe-row2">
                  <div className="fe-d"><b>Reads only</b><small>It can look at the diff and files, never change them.</small></div>
                  <Switch on={draft.readsOnly} label="Reads only" onChange={(on) => set({ readsOnly: on })} />
                </div>
                <div className="fe-tools">
                  {TOOL_IDS.map((t) => {
                    const on = draft.tools.includes(t);
                    return (
                      <button key={t} type="button" role="checkbox" aria-checked={on} className="fe-tl" data-on={on ? "" : undefined}
                        onClick={() => set({ tools: on ? draft.tools.filter((x) => x !== t) : [...draft.tools, t] })}>
                        <span className="fe-ck"><FlowIcon name="check" size={ICON.xs} /></span><div>{TOOL_WORD[t]}<small>{TOOL_SAYS[t]}</small></div>
                      </button>
                    );
                  })}
                </div>
                <div className="fe-xcmd">
                  <div className="fe-xhead"><b>Extra commands this role may run</b></div>
                  <AllowBox allow={draft.allow} onChange={(allow) => set({ allow })} />
                  <div className="fe-xlock"><FlowIcon name="lock" size={12} /><span>Never allowed for any worker:</span>{NEVER_LIFTABLE.map((c) => <code key={c}>{c}</code>)}</div>
                </div>
              </>)}

            {!isNew && sec("rules", "Rules that move it", <small>first match wins</small>, role?.policyRole
              ? <BlockRules role={role.policyRole} flow={p.flow} a={p.around} onSaved={p.onRuleSaved} />
              : <p className="fe-wedquiet">Rules change the engine of a role the policy knows. This one runs the chain you give it.</p>)}

            {sec("check", "Who checks this", null, reviewer && role?.id
              ? <ReviewerControls root={p.root} name={role.name} firstEngine={draft.chain[0] ?? null} rounds={liveRounds}
                  onRounds={async (n) => { const kept = await p.onReviewRounds(role.id, n); if (kept) set({ rounds: Math.min(n, REVIEW_ROUNDS_MAX) }); return kept; }} />
              : (
                <div className="fe-wedrow">
                  <span className="fe-wedval">Checking is set on {reviewerName(p.flow)}.</span>
                  {p.flow.roster.find((r) => r.policyRole === "reviewer") && (
                    <button type="button" className="fe-btn" data-size="sm" onClick={() => { const r = p.flow.roster.find((x) => x.policyRole === "reviewer"); if (r) p.onOpenRole(r.id); }}>
                      <FlowIcon name="eye" size={ICON.xs} />Open {reviewerName(p.flow)}
                    </button>
                  )}
                </div>
              ))}
          </div>

          <aside className="fe-prev" aria-label="Preview">
            <div>
              <h5>Live preview</h5>
              <div className="fe-prevcard" {...({ inert: "" } as object)}>
                <WorkerCard flow={preview} role={previewRole} x={0} y={0} selected={false} dragging={false}
                  onPointerDown={() => {}} onOpen={() => {}} onSelect={() => {}} onArrow={() => {}} onConfigure={() => {}} />
              </div>
            </div>
            <div>
              <h5>Changes</h5>
              <p>{isNew ? <>Nothing is saved until you press <b>Add worker</b>.</>
                : role?.policyRole ? <>Engine, model, fallbacks and Ask save as soon as you change them. Name, line, prompt, tools, exits and Required wait for <b>Save role</b>.</>
                  : <>Nothing here saves on its own: name, line, prompt, engine chain, tools, exits and Required all wait for <b>Save role</b>.</>}</p>
            </div>
            <div>
              <h5>Same everywhere</h5>
              <p>A role is the same in every project. Rules and presets can still move it per project.</p>
            </div>
          </aside>
        </div>

        <div className="fe-ef">
          {isNew
            ? <span className="fe-badge" data-tone="warn"><i />Not added yet</span>
            : ownChain
              ? <span className="fe-badge" data-tone="off"><i />Nothing saved until you press Save role</span>
              : <span className="fe-badge" data-tone="ok"><i />Engine and model saved</span>}
          {!isNew && edited && <span className="fe-badge" data-tone="warn"><i />Prompt edited, not saved</span>}
          <span className="fe-sp" />
          <button className="fe-btn" type="button" onClick={p.onClose}>Cancel</button>
          <button className="fe-btn" data-tone="primary" type="button" disabled={!canSave} onClick={save}><FlowIcon name={isNew ? "plus" : "check"} size={ICON.xs} />{isNew ? "Add worker" : "Save role"}</button>
        </div>
      </div>
    </div>
  );
}
