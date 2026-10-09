import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Field, UiAction, UiNode, UiOpenPr } from "../../lib/pluginTypes.ts";
import { openPr } from "../../lib/openPrs.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { openExternal } from "../../lib/externalUrl.ts";
import { ago } from "../../lib/fileRecents.ts";
import { Select } from "../Select.tsx";
import { Switch } from "../SettingRow.tsx";
import { useDialogs, type ConfirmSpec } from "../ConfirmDialog.tsx";
import { Row, Chip, type Tone as RowTone } from "../git/ui.tsx";
import { DoneIcon } from "../../lib/glyphIcons.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { EDGE, LINE, Button as HouseButton } from "../workspace/Chrome.tsx";

/**
 * A plugin's screen, drawn with this app's own parts.
 *
 * The tree arrives already checked by the server (shared/pluginUi.ts), and is
 * drawn here without trusting that: an unknown node draws nothing, a link goes
 * through the same external opener as every other link, text is text. No node
 * can style itself — a tone is a word mapped below onto the theme's tokens, so
 * a plugin looks like the app in every theme without knowing any of them.
 *
 * `onAction` is the only way out. A button, a row, a submitted form: each
 * sends the plugin's own action id back to the plugin, and nothing else.
 */

type Tone = "default" | "muted" | "accent" | "success" | "warning" | "danger";

const TONE_COLOR: Record<Tone, string> = {
  default: "var(--text)",
  muted: "var(--text3)",
  accent: "var(--primary)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--error)",
};

const TO_ROW_TONE: Record<Tone, RowTone> = {
  default: "neutral", muted: "neutral", accent: "accent", success: "good", warning: "warn", danger: "bad",
};

const GAP = { sm: 6, md: 12, lg: 20 } as const;

export type ActionFn = (action: UiAction, values?: Record<string, unknown>) => Promise<void>;

interface Ctx {
  onAction: ActionFn;
  /** Bumped whenever the plugin redraws, so a pressed button can stop
   *  spinning when its answer arrives rather than after a guess. */
  version: number;
  ask: (spec: ConfirmSpec) => Promise<boolean>;
}

/**
 * What pressing a row does.
 *
 * `open` is the app's errand and `action` is the plugin's, and a row may carry
 * both — a reviewer's row opens the pull request AND tells the plugin the
 * finding has been looked at. The app's runs first and never waits for the
 * plugin's: a slow plugin must not delay the thing the click was for.
 */
function rowClick(it: { action?: UiAction; open?: UiOpenPr }, ctx: Ctx): (() => void) | undefined {
  if (!it.action && !it.open) return undefined;
  return () => {
    if (it.open) openPr(it.open.repo, it.open.number, { focus: it.open.focus });
    if (it.action) void ctx.onAction(it.action);
  };
}

export function PluginTree({ node, onAction, version }: { node: UiNode; onAction: ActionFn; version: number }) {
  const { ask, dialog } = useDialogs();
  const ctx: Ctx = { onAction, version, ask };
  return (
    <>
      <Node node={node} ctx={ctx} />
      {dialog}
    </>
  );
}

function Nodes({ nodes, ctx }: { nodes: UiNode[]; ctx: Ctx }) {
  return <>{nodes.map((n, i) => <Node key={i} node={n} ctx={ctx} />)}</>;
}

function Node({ node, ctx }: { node: UiNode; ctx: Ctx }): ReactNode {
  switch (node.type) {
    case "stack":
      return (
        <div className="flex flex-col min-w-0" style={{ gap: GAP[node.gap ?? "md"] }}>
          <Nodes nodes={node.children} ctx={ctx} />
        </div>
      );
    case "row":
      return (
        <div className="flex min-w-0" style={{
          gap: GAP[node.gap ?? "sm"],
          alignItems: "center",
          justifyContent: node.align === "between" ? "space-between" : node.align === "center" ? "center" : "flex-start",
          flexWrap: node.wrap ? "wrap" : "nowrap",
        }}>
          <Nodes nodes={node.children} ctx={ctx} />
        </div>
      );
    case "section":
      return (
        <section className="rounded-lg min-w-0" style={{ background: "var(--surface-card)", border: EDGE, boxShadow: "var(--surface-lift)" }}>
          <header className="flex items-center gap-3 px-3.5 pt-3 pb-2">
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-semibold truncate" style={{ color: "var(--text)" }}>{node.title}</div>
              {node.subtitle && <div className="text-[11px] truncate" style={{ color: "var(--text3)" }}>{node.subtitle}</div>}
            </div>
            {node.actions && node.actions.length > 0 && <div className="flex items-center gap-1.5 shrink-0"><Nodes nodes={node.actions} ctx={ctx} /></div>}
          </header>
          <div className="px-3.5 pb-3.5 flex flex-col gap-3 min-w-0"><Nodes nodes={node.children} ctx={ctx} /></div>
        </section>
      );
    case "split":
      return <Split node={node} ctx={ctx} />;
    case "tabs":
      return <Tabs node={node} ctx={ctx} />;
    case "heading": {
      const size = node.level === 1 ? 18 : node.level === 3 ? 12.5 : 15;
      return <div className="font-semibold tracking-tight min-w-0" style={{ fontSize: size, color: "var(--text)", lineHeight: 1.25 }}>{node.text}</div>;
    }
    case "text":
      return (
        <div className={`min-w-0 whitespace-pre-wrap break-words ${node.mono ? "t-mono" : ""}`}
          style={{ fontSize: node.size === "sm" ? 11 : 12.5, color: TONE_COLOR[node.tone ?? "default"], lineHeight: 1.5 }}>
          {node.text}
        </div>
      );
    case "markdown":
      return <div className="agx-prose min-w-0 text-[12.5px]"><Markdown text={node.text} /></div>;
    case "code":
      return (
        <pre className="t-mono text-[11.5px] rounded-md px-3 py-2 overflow-auto min-w-0 m-0"
          style={{ background: "var(--surface-inset)", border: EDGE, color: "var(--text2)", maxHeight: 420 }}>
          {node.text}
        </pre>
      );
    case "badge":
      return <Badge text={node.text} tone={node.tone} />;
    case "stat":
      return (
        <div className="rounded-lg px-3 py-2.5 min-w-[112px] self-stretch" style={{ background: "var(--surface-inset)", border: EDGE }}>
          <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text3)" }}>{node.label}</div>
          <div className="text-[20px] font-semibold tabular-nums leading-tight" style={{ color: TONE_COLOR[node.tone ?? "default"] }}>{node.value}</div>
          {node.hint && <div className="text-[10.5px] mt-0.5" style={{ color: "var(--text3)" }}>{node.hint}</div>}
        </div>
      );
    case "keyValue":
      return (
        <dl className="grid gap-x-4 gap-y-1.5 m-0 min-w-0" style={{ gridTemplateColumns: "max-content minmax(0, 1fr)" }}>
          {node.items.map((it, i) => (
            <div key={i} className="contents">
              <dt className="text-[11px]" style={{ color: "var(--text3)" }}>{it.label}</dt>
              <dd className="text-[12px] m-0 truncate" style={{ color: TONE_COLOR[it.tone ?? "default"] }} title={it.value}>{it.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "list":
      if (node.items.length === 0) return <Quiet text={node.empty ?? "Nothing here yet."} />;
      return (
        <div className="flex flex-col gap-1 min-w-0">
          {node.items.map((it) => (
            <Row key={it.id}
              rail={it.badges?.[0]?.tone ? TO_ROW_TONE[it.badges[0].tone] : undefined}
              title={it.title}
              chips={it.badges?.length ? <>{it.badges.map((b, i) => <Chip key={i} tone={TO_ROW_TONE[b.tone ?? "default"]}>{b.text}</Chip>)}</> : undefined}
              facts={[it.subtitle, it.meta].filter((x): x is string => !!x)}
              selected={it.selected}
              onClick={rowClick(it, ctx)} />
          ))}
        </div>
      );
    case "timeline":
      if (node.items.length === 0) return <Quiet text={node.empty ?? "Nothing has happened yet."} />;
      return (
        <ol className="relative m-0 p-0 list-none min-w-0">
          <span aria-hidden className="absolute" style={{ left: 5, top: 6, bottom: 6, width: 1.5, background: "var(--surface-line)" }} />
          {node.items.map((it) => (
            <li key={it.id} className="relative pl-6 pb-4 last:pb-0 min-w-0">
              <span aria-hidden className="absolute rounded-full" style={{
                left: 0, top: 4, width: 12, height: 12,
                background: "var(--bg)", border: `2px solid ${TONE_COLOR[it.tone ?? "muted"]}`,
              }} />
              <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
                <button type="button" disabled={!it.action && !it.open}
                  onClick={rowClick(it, ctx)}
                  className={`text-[12.5px] font-medium text-left ${it.action || it.open ? "agx-rowhit hover:underline" : "cursor-default"}`}
                  style={{ color: "var(--text)", background: "transparent", border: 0, padding: 0 }}>
                  {it.title}
                </button>
                {it.badges?.map((b, i) => <Badge key={i} text={b.text} tone={b.tone} />)}
                {it.at && <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text4)" }} title={new Date(it.at).toLocaleString()}>{ago(it.at)}</span>}
              </div>
              {it.body && <div className="agx-prose text-[12px] mt-1 min-w-0" style={{ color: "var(--text2)" }}><Markdown text={it.body} /></div>}
            </li>
          ))}
        </ol>
      );
    case "button":
      return <Button node={node} ctx={ctx} />;
    case "form":
      return <Form node={node} ctx={ctx} />;
    case "progress":
      return (
        <div className="flex flex-col gap-1 min-w-0">
          <div className="relative h-[5px] rounded-full overflow-hidden" style={{ background: "var(--surface-inset)" }}>
            {node.value === undefined
              ? <div className="absolute inset-0 agx-skeleton" />
              : <div className="absolute left-0 top-0 bottom-0 rounded-full transition-[width]" style={{ width: `${Math.round(node.value * 100)}%`, background: "var(--primary)" }} />}
          </div>
          {node.label && <div className="text-[11px]" style={{ color: "var(--text3)" }}>{node.label}</div>}
        </div>
      );
    case "empty":
      return (
        <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-6">
          <div className="text-[13px] font-medium" style={{ color: "var(--text2)" }}>{node.title}</div>
          {node.body && <div className="agx-prose text-[12px] max-w-[46ch]" style={{ color: "var(--text3)" }}><Markdown text={node.body} /></div>}
          {node.action && <div className="mt-2"><Node node={node.action} ctx={ctx} /></div>}
        </div>
      );
    case "link":
      return (
        <a href={node.href} onClick={(e) => { e.preventDefault(); openExternal(node.href); }}
          className="text-[12px] hover:underline" style={{ color: "var(--primary-ink)" }} title={node.href}>
          {node.text} ↗
        </a>
      );
    case "divider":
      return <hr className="m-0 border-0" style={{ height: 1, background: "var(--surface-line)" }} />;
    default:
      return null;
  }
}

function Badge({ text, tone }: { text: string; tone?: Tone }) {
  const c = TONE_COLOR[tone ?? "muted"];
  return (
    <span className="shrink-0 text-[10px] px-1.5 py-px rounded-full uppercase tracking-wide whitespace-nowrap"
      style={{ color: c, background: `color-mix(in srgb, ${c} 12%, transparent)` }}>{text}</span>
  );
}

function Quiet({ text }: { text: string }) {
  return <div className="text-[12px] py-3" style={{ color: "var(--text3)" }}>{text}</div>;
}

function Split({ node, ctx }: { node: Extract<UiNode, { type: "split" }>; ctx: Ctx }) {
  const cols = node.leftWidth === "half" ? "minmax(0,1fr) minmax(0,1fr)" : "minmax(240px, 320px) minmax(0, 1fr)";
  return (
    <div className="grid gap-4 min-h-0 min-w-0 h-full" style={{ gridTemplateColumns: cols }}>
      <div className="min-w-0 min-h-0 overflow-auto flex flex-col gap-3 pr-1"><Nodes nodes={node.left} ctx={ctx} /></div>
      <div className="min-w-0 min-h-0 overflow-auto flex flex-col gap-3 pr-1"><Nodes nodes={node.right} ctx={ctx} /></div>
    </div>
  );
}

function Tabs({ node, ctx }: { node: Extract<UiNode, { type: "tabs" }>; ctx: Ctx }) {
  const first = node.tabs[0]?.id ?? "";
  const [sel, setSel] = useState(node.selected ?? first);
  // The plugin may move the selection itself (a new review lands and it
  // wants its findings showing); follow it when it does.
  useEffect(() => { if (node.selected) setSel(node.selected); }, [node.selected]);
  const cur = node.tabs.find((t) => t.id === sel) ?? node.tabs[0];
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div role="tablist" className="flex items-center gap-1 min-w-0 overflow-x-auto" style={{ borderBottom: LINE }}>
        {node.tabs.map((t) => {
          const on = t.id === cur?.id;
          return (
            <button key={t.id} role="tab" aria-selected={on} type="button" onClick={() => setSel(t.id)}
              className="agx-btn text-[11.5px] px-2.5 h-[30px] inline-flex items-center gap-1.5 whitespace-nowrap"
              style={{
                color: on ? "var(--text)" : "var(--text3)", background: "transparent", border: 0, borderRadius: 0,
                boxShadow: on ? "inset 0 -2px 0 var(--primary)" : "none",
              }}>
              {t.label}
              {t.badge && <span className="text-[10px] tabular-nums px-1 rounded" style={{ background: "var(--surface-inset)", color: "var(--text2)" }}>{t.badge}</span>}
            </button>
          );
        })}
      </div>
      {cur && <div className="flex flex-col gap-3 min-w-0"><Nodes nodes={cur.children} ctx={ctx} /></div>}
    </div>
  );
}

/** Spins from the press until the plugin redraws, with a ceiling so a plugin
 *  that answers nothing does not leave a button spinning forever. */
function usePending(version: number): [boolean, (p: Promise<unknown>) => void] {
  const [pending, setPending] = useState(false);
  const at = useRef(version);
  const ceiling = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => { if (ceiling.current) clearTimeout(ceiling.current); ceiling.current = null; setPending(false); };
  // The answer is the redraw, not the POST: `/plugins/action` returns at once
  // whatever the plugin later does, so settling the request says nothing.
  useEffect(() => { if (version !== at.current) stop(); }, [version]);
  useEffect(() => () => { if (ceiling.current) clearTimeout(ceiling.current); }, []);
  const run = (p: Promise<unknown>) => {
    at.current = version;
    setPending(true);
    if (ceiling.current) clearTimeout(ceiling.current);
    ceiling.current = setTimeout(stop, 15_000);
    p.catch(stop);
  };
  return [pending, run];
}

function Button({ node, ctx }: { node: Extract<UiNode, { type: "button" }>; ctx: Ctx }) {
  const [pending, run] = usePending(ctx.version);
  const press = async () => {
    if (node.confirm && !(await ctx.ask({ title: node.label, body: node.confirm, confirmLabel: node.label, danger: node.tone === "danger" }))) return;
    run(ctx.onAction(node.action));
  };
  return (
    <HouseButton onClick={() => { void press(); }} disabled={node.disabled} pending={pending}
      tone={node.tone === "default" ? "plain" : node.tone}>
      {node.label}
    </HouseButton>
  );
}

function Form({ node, ctx }: { node: Extract<UiNode, { type: "form" }>; ctx: Ctx }) {
  // Keyed on what the values ARE, not on the object: every redraw of any
  // panel arrives as a new object, and resetting on identity wiped whatever
  // the person was typing each time a plugin drew progress.
  const valuesKey = JSON.stringify(node.values ?? {});
  const initial = useMemo(() => ({ ...(node.values ?? {}) }), [valuesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  useEffect(() => setValues(initial), [initial]);
  const [pending, run] = usePending(ctx.version);
  return (
    <form className="flex flex-col gap-3 min-w-0" onSubmit={(e) => { e.preventDefault(); run(ctx.onAction(node.submit.action, values)); }}>
      {node.fields.map((f) => (
        <FieldRow key={f.key} field={f} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
      ))}
      <div>
        <HouseButton type="submit" tone="primary" pending={pending}>{node.submit.label}</HouseButton>
      </div>
    </form>
  );
}

/**
 * One input for one declared field. Shared with the plugin's settings page so
 * a field looks and behaves the same wherever a plugin asks for it.
 */
export function FieldRow({ field, value, onChange, onCommit }: {
  field: Field; value: unknown; onChange: (v: unknown) => void;
  /** Settings save on blur or on a discrete change; a plugin's own form
   *  saves on submit and leaves this out. */
  onCommit?: (v: unknown) => void;
}) {
  /*
   * Label, then the sentence under it — clipped to two lines.
   *
   * A settings page where every field carries three lines of prose is a page
   * of prose with inputs in it: the eye has to read everything to find the
   * one thing being changed. The whole sentence is still there on hover and
   * for a screen reader; what is cut is the height it took from the controls.
   */
  const label = (
    <div className="min-w-0">
      <div className="text-[12px] font-medium" style={{ color: "var(--text)" }}>{field.label}</div>
      {field.description && (
        <div className="text-[11px] mt-0.5" title={field.description} style={{
          color: "var(--text3)",
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
        }}>{field.description}</div>
      )}
    </div>
  );
  const inputStyle: CSSProperties = { width: "100%" };
  if (field.type === "boolean") {
    const on = value === true;
    return (
      <button type="button" className="flex items-center justify-between gap-4 text-left min-w-0 agx-rowhit rounded-md px-0"
        style={{ background: "transparent", border: 0 }}
        role="switch" aria-checked={on}
        onClick={() => { onChange(!on); onCommit?.(!on); }}>
        {label}
        <Switch on={on} />
      </button>
    );
  }
  let control: ReactNode;
  if (field.type === "multi") {
    control = <MultiPick field={field} value={Array.isArray(value) ? (value as string[]) : []}
      onChange={(v) => { onChange(v); onCommit?.(v); }} />;
  } else if (field.type === "select") {
    // In the input's box, full width, like every other field on the page: on
    // its own the trigger is a bare word and did not read as a control.
    control = (
      <Select value={typeof value === "string" ? value : ""} placeholder="Choose…"
        className="agx-input w-full justify-between"
        options={(field.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
        onChange={(v) => { onChange(v); onCommit?.(v); }} />
    );
  } else if (field.type === "text" || field.type === "list") {
    const text = field.type === "list" ? (Array.isArray(value) ? value.join("\n") : "") : typeof value === "string" ? value : "";
    control = (
      <textarea className="agx-input t-mono" rows={field.type === "list" ? Math.min(8, Math.max(3, text.split("\n").length + 1)) : 5}
        style={{ ...inputStyle, resize: "vertical" }} placeholder={field.placeholder ?? (field.type === "list" ? "One per line" : "")}
        value={text}
        onChange={(e) => onChange(field.type === "list" ? e.target.value.split("\n") : e.target.value)}
        onBlur={(e) => onCommit?.(field.type === "list" ? e.target.value.split("\n") : e.target.value)} />
    );
  } else if (field.type === "number") {
    /* A number is short, and a box the width of the page for "10" is what
       makes a settings page read as a form to fill in rather than a few
       things to set. It sits beside its label instead. */
    return (
      <div className="flex items-center justify-between gap-4 min-w-0">
        {label}
        <div className="shrink-0" style={{ width: 128 }}>
          <NumberInput field={field} value={value} onChange={onChange} onCommit={onCommit} style={inputStyle} />
        </div>
      </div>
    );
  } else {
    control = (
      <input className="agx-input" style={inputStyle} type="text" placeholder={field.placeholder}
        value={value === null || value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit?.(e.target.value)} />
    );
  }
  /* Short controls sit beside their label; only the ones that need the width
     — a prompt, a list, a picker with a search box — take the row under it.
     A select of one word stretched across the page was what made every field
     look like the same amount of work. */
  const wide = field.type === "text" || field.type === "list" || field.type === "multi";
  if (wide) {
    return (
      <label className="flex flex-col gap-1.5 min-w-0">
        {label}
        {control}
      </label>
    );
  }
  return (
    <label className="flex items-center justify-between gap-4 min-w-0">
      {label}
      <div className="shrink-0" style={{ width: 260, maxWidth: "46%" }}>{control}</div>
    </label>
  );
}

/** A number is typed as text and read as a number when it is committed:
 *  "-" and "1." are steps on the way to a number, and coercing each keystroke
 *  turned them into "NaN" and "1". */
function NumberInput({ field, value, onChange, onCommit, style }: {
  field: Field; value: unknown; onChange: (v: unknown) => void; onCommit?: (v: unknown) => void; style: CSSProperties;
}) {
  const shown = value === null || value === undefined ? "" : String(value);
  const [raw, setRaw] = useState(shown);
  useEffect(() => setRaw(shown), [shown]);
  const parse = (t: string) => (t.trim() === "" ? null : Number.isFinite(Number(t)) ? Number(t) : undefined);
  return (
    <input className="agx-input" style={style} type="text" inputMode="decimal" placeholder={field.placeholder}
      value={raw}
      onChange={(e) => { setRaw(e.target.value); const n = parse(e.target.value); if (n !== undefined) onChange(n); }}
      onBlur={() => { const n = parse(raw); if (n === undefined) setRaw(shown); else onCommit?.(n); }} />
  );
}

/**
 * Several picked from a list the plugin supplies — the repositories the person
 * can reach, say, which can be hundreds. Inline rather than a floating menu:
 * what is chosen stays in view as chips, the search narrows the list under it,
 * and nothing has to be drawn over the dialog it sits in.
 *
 * A value that is not among the options (typed before the options arrived, or
 * a repository access was since lost to) is kept and shown, marked, so it can
 * be taken off rather than silently disappearing.
 */
function MultiPick({ field, value, onChange }: { field: Field; value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState("");
  const options = field.options ?? [];
  const known = new Set(options.map((o) => o.value));
  const chosen = new Set(value);
  const needle = q.trim().toLowerCase();
  const shown = (needle ? options.filter((o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle)) : options).slice(0, 200);
  const toggle = (v: string) => onChange(chosen.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="flex flex-col gap-2 min-w-0">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => (
            <span key={v} className="inline-flex items-center gap-1.5 text-[11.5px] pl-2 pr-1 py-0.5 rounded-md"
              style={{
                color: known.has(v) || options.length === 0 ? "var(--text)" : "var(--warning)",
                background: "color-mix(in srgb, var(--primary) 12%, transparent)",
                border: "1px solid color-mix(in srgb, var(--primary) 35%, transparent)",
              }}
              title={known.has(v) || options.length === 0 ? v : `${v} — not in the list any more`}>
              <span className="t-mono">{options.find((o) => o.value === v)?.label ?? v}</span>
              <button type="button" onClick={() => toggle(v)} aria-label={`Remove ${v}`}
                className="agx-btn rounded grid place-items-center" style={{ color: "var(--text3)", width: ICON.md, height: ICON.md }}><CloseIcon size={ICON.xs} /></button>
            </span>
          ))}
        </div>
      )}
      {options.length === 0 ? (
        <div className="text-[11.5px] t-dim">{field.placeholder ? `Loading… (for example ${field.placeholder})` : "Loading the list…"}</div>
      ) : (
        <div className="rounded-lg overflow-hidden" style={{ border: EDGE }}>
          <input className="agx-input t-mono w-full" style={{ border: 0, borderRadius: 0, borderBottom: LINE }}
            placeholder={`Search ${options.length} …`} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="max-h-[220px] overflow-y-auto py-1">
            {shown.length === 0 && <div className="px-3 py-2 text-[11.5px] t-dim">Nothing matches “{q.trim()}”.</div>}
            {shown.map((o) => {
              const on = chosen.has(o.value);
              return (
                <button key={o.value} type="button" onClick={() => toggle(o.value)} role="checkbox" aria-checked={on}
                  className="agx-rowhit w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] t-mono"
                  style={{ color: on ? "var(--text)" : "var(--text2)", background: on ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "transparent" }}>
                  <span className="shrink-0 grid place-items-center rounded" style={{
                    width: 16, height: 16,
                    border: `1px solid ${on ? "var(--primary)" : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
                    background: on ? "var(--primary)" : "transparent", color: "var(--bg)",
                  }}>{on && <DoneIcon size={ICON.xs} />}</span>
                  <span className="truncate">{o.label}</span>
                </button>
              );
            })}
            {!needle && options.length > shown.length && (
              <div className="px-3 py-1.5 text-[10.5px] t-dim">{options.length - shown.length} more — search to find them</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
