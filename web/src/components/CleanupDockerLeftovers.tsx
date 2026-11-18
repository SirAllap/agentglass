/*
 * "Docker leftovers" in the cleanup settings: the image tag template, the volume patterns, the keep list and the switch for
 * the sweep to remove by itself. Saved per project. The three fields live in the project's `cleanup.config` object, which
 * the door replaces whole, so each save reads it fresh and changes only these; the switch is its own setting, and turning it
 * on waits for the person's approval (it deletes volumes).
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { ICON } from "../lib/iconSize.ts";
import { checkTemplateText, DOCKER_TEMPLATE_HELP, leftoverFieldsOf, listOfText, ORPHAN_KEEP_HELP, ORPHAN_VOLUMES_HELP, withLeftovers } from "../lib/cleanupSettings.ts";
import { WarningIcon } from "../lib/glyphIcons.tsx";
import { INPUT, INPUT_STYLE, Button } from "./workspace/Chrome.tsx";

export function DockerLeftovers({ root, dis, write }: { root: string; dis: boolean; write: (id: string, value: unknown) => Promise<boolean> }) {
  const [saved, setSaved] = useState({ template: "", patterns: [] as string[], keep: [] as string[] });
  const [tmpl, setTmpl] = useState("");
  const [pats, setPats] = useState("");
  const [keep, setKeep] = useState("");
  const [auto, setAuto] = useState(false);
  const [why, setWhy] = useState("");

  useEffect(() => {
    if (!root) return;
    let live = true;
    void Promise.all([api.settingAt("cleanup.config", root), api.settingAt("cleanup.orphanAutoRemove", root)]).then(([c, a]) => {
      if (!live) return;
      const f = leftoverFieldsOf(c.value);
      setSaved(f); setTmpl(f.template); setPats(f.patterns.join("\n")); setKeep(f.keep.join("\n")); setAuto(a.value === true); setWhy("");
    }).catch(() => { if (live) setWhy("Could not read this project's Docker leftovers settings."); });
    return () => { live = false; };
  }, [root]);

  const next = { template: tmpl.trim(), patterns: listOfText(pats), keep: listOfText(keep) };
  const dirty = next.template !== saved.template || next.patterns.join("\n") !== saved.patterns.join("\n") || next.keep.join("\n") !== saved.keep.join("\n");
  const save = async () => {
    const bad = checkTemplateText(next.template);
    if (bad) { setWhy(bad); return; }
    setWhy("");
    const cur = await api.settingAt("cleanup.config", root).catch(() => null);
    if (!cur?.ok) { setWhy("Could not read this project's cleanup settings."); return; }
    if (await write("cleanup.config", withLeftovers(cur.value, next))) setSaved(next);
  };
  const flip = async () => {
    const was = auto; setAuto(!was);
    if (!(await write("cleanup.orphanAutoRemove", !was))) setAuto(was);
  };

  return (
    <div className="agx-cl-ev" data-cl-kind="docker-leftovers" aria-label="Docker leftovers">
      <b>Docker leftovers</b>
      <span className="agx-cl-mute">{DOCKER_TEMPLATE_HELP}</span>
      <input className={`${INPUT} agx-cl-evin`} style={INPUT_STYLE} value={tmpl} disabled={dis} placeholder="app:{sha}" aria-label="Image tag template"
        onChange={(e) => { setTmpl(e.target.value); setWhy(""); }} />
      <span className="agx-cl-mute">{ORPHAN_VOLUMES_HELP}</span>
      <textarea className={`${INPUT} agx-cl-evin`} style={INPUT_STYLE} rows={2} value={pats} disabled={dis} placeholder="app-cache-{slug}" aria-label="Orphan volume patterns"
        onChange={(e) => { setPats(e.target.value); setWhy(""); }} />
      <span className="agx-cl-mute">{ORPHAN_KEEP_HELP}</span>
      <textarea className={`${INPUT} agx-cl-evin`} style={INPUT_STYLE} rows={2} value={keep} disabled={dis} placeholder="psql-*" aria-label="Volumes the sweep never lists"
        onChange={(e) => { setKeep(e.target.value); setWhy(""); }} />
      <span className="agx-cl-evadd">
        <Button size="compact" tone="primary" disabled={dis || !dirty} onClick={() => void save()}>Save</Button>
      </span>
      {why && <span role="alert" className="agx-cl-problem"><WarningIcon size={ICON.sm} />{why}</span>}
      <label className="agx-cl-mute" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={auto} disabled={dis} onChange={() => void flip()} aria-label="Remove the listed leftovers by itself" />
        Remove the listed leftovers by itself when Docker &gt; Disk loads. Off by default; turning it on waits for your approval.
      </label>
    </div>
  );
}
