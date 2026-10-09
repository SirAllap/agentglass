import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import type { Field } from "../../lib/pluginTypes.ts";
import { subscribePluginFrame } from "../../lib/pluginBus.ts";
import { Spinner } from "../Spinner.tsx";
import { FieldRow } from "./PluginTree.tsx";

/**
 * The fields under each heading, in the order they were declared.
 *
 * A manifest lists fields flat; a person reads a page. Thirteen identical
 * rows in one column is a wall — nobody starts configuring that — and only
 * the plugin knows which of its fields belong together, so it says so with
 * `group` and this arranges them. Ungrouped fields come first, under no
 * heading at all, because a heading over "the two things you must set" is
 * one more word between somebody and the two things.
 */
function groupsOf(fields: Field[]): { name?: string; fields: Field[] }[] {
  const out: { name?: string; fields: Field[] }[] = [];
  for (const f of fields) {
    const last = out.find((g) => g.name === f.group);
    if (last) last.fields.push(f);
    else out.push({ name: f.group, fields: [f] });
  }
  // Ungrouped first, then the declared order of the groups themselves.
  return out.sort((a, b) => (a.name ? 1 : 0) - (b.name ? 1 : 0));
}

/** A titled card of fields. One named "Advanced" starts folded: it is the
 *  word a plugin uses for "you will not need this", and a page that opens
 *  with it shut is a page that looks like less work. */
function Group({ name, count, children }: { name?: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(!/^advanced$/i.test(name ?? ""));
  const box = { background: "var(--surface-card)", border: "1px solid var(--surface-line)" };
  if (!name) return <div className="rounded-lg flex flex-col" style={box}>{children}</div>;
  return (
    <section className="rounded-lg flex flex-col" style={box}>
      <button onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-4 py-2.5 text-left"
        style={{ background: "transparent", border: 0, borderBottom: open ? "1px solid var(--surface-line)" : undefined }}>
        <span className="text-[10px] uppercase tracking-[.12em]" style={{ color: "var(--text3)" }}>{name}</span>
        <span className="text-[10px] tabular-nums t-dim">{count}</span>
        <span className="ml-auto text-[11px] t-dim">{open ? "−" : "+"}</span>
      </button>
      {open && children}
    </section>
  );
}

/**
 * A plugin's settings page, drawn from the fields its manifest declared.
 *
 * Every field saves on its own when it is committed — a toggle when flipped,
 * a text box when it loses focus — like every other page in Settings, where
 * there is no Save button to forget. What is stored is typed by the manifest
 * on the server, so the plugin reads a list where it declared a list whatever
 * was typed here. The plugin hears each save as a `settings` event.
 */
export function PluginSettingsPane({ name, open }: { name: string; open: boolean }) {
  const [fields, setFields] = useState<Field[] | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (keepValues: boolean) => {
    try {
      const r = await api.pluginSettings(name);
      if (!r.ok) { setError(r.error ?? "no such plugin"); setFields([]); return; }
      setFields(r.fields);
      if (!keepValues) setValues(r.values);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [name]);

  useEffect(() => { if (open) void load(false); }, [open, load]);
  // The plugin can publish the choices for a select once it has looked
  // around (which agents are installed, say); pick those up without losing
  // what is being typed.
  // Only the ping without a panel: that is the one a change of options sends;
  // a panel redrawing is not news to a settings page.
  useEffect(() => subscribePluginFrame((f) => { if (f.kind === "panels" && !f.panel) void load(true); }), [load]);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  const commit = async (key: string, v: unknown) => {
    const r = await api.pluginSettingsSave(name, { [key]: v });
    if (!r.ok) { setError(r.error ?? "not saved"); return; }
    if (r.values) setValues(r.values);
    setError(null);
    setSaved(key);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(null), 1600);
  };

  if (fields === null) return <div className="px-4 py-6"><Spinner label="Loading settings…" /></div>;

  return (
    <div className="flex flex-col gap-4 px-1 pb-6">
      {error && (
        <div className="text-[11.5px] rounded-md px-3 py-2" style={{ color: "var(--error-ink)", background: "color-mix(in srgb, var(--error) 8%, transparent)" }}>{error}</div>
      )}
      {groupsOf(fields).map((g) => (
        <Group key={g.name ?? ""} name={g.name} count={g.fields.length}>
          {g.fields.map((f, i) => (
            <div key={f.key} className="px-4 py-3.5 flex flex-col gap-1" style={{ borderTop: i ? "1px solid var(--surface-line)" : undefined }}>
              <FieldRow field={f} value={values[f.key]}
                onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
                onCommit={(v) => { void commit(f.key, v); }} />
              <div className="h-3 text-[10.5px]" style={{ color: "var(--success-ink)" }} aria-live="polite">{saved === f.key ? "Saved" : ""}</div>
            </div>
          ))}
        </Group>
      ))}
      <p className="text-[11px] m-0 px-1" style={{ color: "var(--text3)" }}>
        These are {name}'s own settings, declared in its manifest and kept by this app. The plugin reads them over its
        own token and hears every change.
      </p>
    </div>
  );
}
