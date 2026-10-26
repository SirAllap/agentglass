import { useEffect, useState } from "react";
import { SettingRow } from "../SettingRow.tsx";
import { Button } from "../workspace/Chrome.tsx";
import { INPUT_STYLE } from "../workspace/Chrome.tsx";
import { api } from "../../lib/api.ts";
import { LAUNCH_MODES, LAUNCH_MODE_LABEL, parseFlagLine, type LaunchMode } from "../../../../shared/launchModes.ts";

type Flags = Record<string, Record<string, string[]>>;

/**
 * What one engine is started with in each permission mode (server/src/launchperm.ts).
 * Prefilled with the built-in words, or the person's own where they typed some;
 * an empty line means no flags. Held by the server: loosening a mode is an
 * escalation, so an agent asks the settings door and waits for the person.
 */
export function LaunchFlagsRows({ kind, title }: { kind: string; title: string }) {
  const [data, setData] = useState<{ overrides: Flags; builtin: Flags } | null>(null);
  const [draft, setDraft] = useState<Partial<Record<LaunchMode, string>>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.launchFlags().then((r) => { if (r.ok) setData(r); }).catch(() => setErr("Could not reach the server.")); }, []);
  if (!data) return err ? <SettingRow agentExempt label="Launch flags" hint={err} /> : null;
  const stored = (m: LaunchMode) => (data.overrides[kind]?.[m] ?? data.builtin[kind]?.[m] ?? []).join(" ");
  const shown = (m: LaunchMode) => draft[m] ?? stored(m);
  const own = Object.keys(data.overrides[kind] ?? {}).length > 0;
  const save = (modes: Record<string, string>) => {
    setErr(null);
    api.launchFlagsSave(kind, modes)
      .then((r) => { if (r.ok) { setData({ ...data, overrides: r.overrides }); setDraft({}); } else setErr(r.error ?? "Could not save that."); })
      .catch(() => setErr("Could not save: server unreachable."));
  };
  const commit = (m: LaunchMode) => {
    const text = shown(m);
    if (text === stored(m)) return;
    const kept: Record<string, string> = {};
    for (const [k, argv] of Object.entries(data.overrides[kind] ?? {})) kept[k] = argv.join(" ");
    save({ ...kept, [m]: text });
  };
  return (
    <>
      {LAUNCH_MODES.map((m) => {
        const bad = parseFlagLine(shown(m));
        return (
          <SettingRow key={m}
            agentNever="the flags an engine starts with in a permission mode: loosening one is an escalation, so an agent asks the settings door and the person answers"
            label={`${title}: launch flags in ${LAUNCH_MODE_LABEL[m]}`}
            hint={shown(m) === "" && !data.overrides[kind]?.[m] ? `${title} has no flag for this mode: it starts in its own default.` : undefined}
            below={
              <div className="flex flex-col gap-1">
                <input aria-label={`${title} launch flags in ${LAUNCH_MODE_LABEL[m]}`} value={shown(m)} spellCheck={false}
                  onChange={(e) => setDraft({ ...draft, [m]: e.target.value })}
                  onBlur={() => bad.ok && commit(m)} onKeyDown={(e) => { if (e.key === "Enter" && bad.ok) commit(m); }}
                  className="w-full text-[12px] px-2.5 py-1.5 rounded-lg outline-none font-mono bg-[var(--surface-inset)] text-[var(--text)]" style={INPUT_STYLE} />
                {!bad.ok && <span className="text-[12px]" role="alert" style={{ color: "var(--error-ink)" }}>{bad.error}</span>}
              </div>}
          />
        );
      })}
      <SettingRow agentExempt label="Launch flags" hint={err ?? "Typed over the built-in ones; an empty line starts the engine with no flag."}
        actions={<Button disabled={!own} onClick={() => save({})}>Reset to default</Button>} />
    </>
  );
}
