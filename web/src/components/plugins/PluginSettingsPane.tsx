import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import type { Field } from "../../lib/pluginTypes.ts";
import { subscribePluginFrame } from "../../lib/pluginBus.ts";
import { Spinner } from "../Spinner.tsx";
import { FieldControl } from "./PluginTree.tsx";
import { SettingRow, Switch } from "../SettingRow.tsx";
import { SettingsCard, StatusBadge } from "../SettingsKit.tsx";
import { PreviewCard, WithPreview } from "../settings/PreviewCard.tsx";
import { pluginPreview } from "../settings/pluginPreviews.tsx";

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
  if (!name) return <SettingsCard label="Settings">{children}</SettingsCard>;
  return (
    <SettingsCard title={name} fold={{ open, onToggle: setOpen }}
      status={<StatusBadge tone="off">{count} {count === 1 ? "setting" : "settings"}</StatusBadge>}>
      {children}
    </SettingsCard>
  );
}

/** One field as a row: the label and its sentence (whole) on the left, the
 *  switch beside them, and anything that takes typing under them. */
function PluginField({ field, value, secretSet, saved, onChange, onCommit }: {
  field: Field; value: unknown; secretSet?: boolean; saved: boolean;
  onChange: (v: unknown) => void; onCommit: (v: unknown) => void;
}) {
  const status = saved ? <StatusBadge tone="ok">Saved</StatusBadge> : undefined;
  if (field.type === "boolean") {
    const on = value === true;
    return (
      <SettingRow label={field.label} hint={field.description} status={status}
        role="switch" ariaChecked={on}
        onClick={() => { onChange(!on); onCommit(!on); }}
        control={<Switch on={on} />} />
    );
  }
  return (
    <SettingRow label={field.label} hint={field.description} status={status}
      below={<FieldControl named field={field} value={value} secretSet={secretSet} onChange={onChange} onCommit={onCommit} />} />
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
  /** Which secret fields hold a value. The values are never sent here. */
  const [secretsSet, setSecretsSet] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (keepValues: boolean) => {
    try {
      const r = await api.pluginSettings(name);
      if (!r.ok) { setError(r.error ?? "no such plugin"); setFields([]); return; }
      setFields(r.fields);
      if (!keepValues) setValues(r.values);
      setSecretsSet(r.set ?? []);
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
    if (r.set) setSecretsSet(r.set);
    setError(null);
    setSaved(key);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(null), 1600);
  };

  if (fields === null) return (
    <SettingsCard label="Settings">
      <SettingRow label={<Spinner label="Loading settings…" />} />
    </SettingsCard>
  );

  const body = (
    <>
      {error && (
        <SettingsCard label="Problem">
          <SettingRow label="This was not saved" status={<StatusBadge tone="err">Failed</StatusBadge>} hint={error} />
        </SettingsCard>
      )}
      {groupsOf(fields).map((g) => (
        <Group key={g.name ?? ""} name={g.name} count={g.fields.length}>
          {g.fields.map((f) => (
            <PluginField key={f.key} field={f} value={values[f.key]} saved={saved === f.key}
              secretSet={f.type === "secret" ? secretsSet.includes(f.key) : undefined}
              onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
              onCommit={(v) => { void commit(f.key, v); }} />
          ))}
        </Group>
      ))}
      <SettingsCard label="About these settings">
        <SettingRow label="Where these settings live"
          hint={`These are ${name}'s own settings, declared in its manifest and kept by this app. The plugin reads them over its own token and hears every change.`} />
      </SettingsCard>
    </>
  );
  // The picture reads the same `values` the rows edit, so it moves with each one.
  const preview = pluginPreview(name, values, secretsSet, fields);
  return preview ? <WithPreview preview={<PreviewCard id={name} title={preview.title}>{preview.node}</PreviewCard>}>{body}</WithPreview> : body;
}
