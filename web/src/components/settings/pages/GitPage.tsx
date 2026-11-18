import { useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { setting } from "../../../lib/settingsRegistry.ts";
import { setReviewGate } from "../../../lib/reviewGatePref.ts";
import { DEFAULT_DAYS, daysOf, daysState, readPick } from "../../../lib/cleanupSettings.ts";
import { type TalkNotify } from "../../../lib/talkNotify.ts";
import { Select } from "../../Select.tsx";
import { Segmented } from "../../workspace/Chrome.tsx";
import { Switch } from "../../orchestration/flow/Switch.tsx";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { TextCommitField, instantSave } from "../save/index.ts";
import { CleanupConfigRows, CleanupInclude, NO_PROJECT_ID, NoProjectNote } from "./CleanupRows.tsx";
import { GIT_ROWS } from "./pageRows.ts";
import type { PageCtx } from "./ctx.ts";

const COPY = Object.fromEntries(GIT_ROWS.map((r) => [r.id, r]));
const row = (id: string) => ({ label: COPY[id].label, help: COPY[id].help });

/** The days after which a merged pull request is cleaned on its own, for the project in view. 0 means never. */
function CleanupDays() {
  const [root, setRoot] = useState<string | null>(null);
  const [days, setDays] = useState({ on: false, shown: String(DEFAULT_DAYS) });
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.projects().then(async (r) => {
      const ws = r.workspaces ?? (r.workspace ? [r.workspace] : []);
      const at = readPick(ws);
      if (!live || !at) return;
      setRoot(at);
      const v = await api.settingAt("cleanup.autoCleanDays", at).catch(() => null);
      if (live && v?.ok) setDays(daysState(v.value));
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const write = async (n: number) => {
    if (!root) return false;
    const r = await api.settingAtSet("cleanup.autoCleanDays", n, root).catch(() => null);
    const ok = !!r && r.ok && r.applied !== false;
    setSaid(ok ? null : "Can't save that right now.");
    return ok;
  };
  const flip = (on: boolean) => {
    const was = days;
    const n = daysOf(days.shown) ?? DEFAULT_DAYS;
    const apply = (s: typeof days) => { setDays(s); void write(s.on ? Number(s.shown) : 0).then((ok) => { if (!ok) setDays(was); }); };
    instantSave(was, { on, shown: String(n) }, apply);
  };
  return (
    <SettingRow kind={root ? "control" : "locked"} reason="" describedBy={NO_PROJECT_ID} {...row("cleanup.autoCleanDays")}
      control={<span className="flex flex-col items-end gap-1"><span className="flex items-center gap-2">
        <TextCommitField label="Days" mono value={days.shown} validate={(v) => (daysOf(v) === null ? "Use a whole number from 1 to 365." : null)}
          onSave={(v) => { const n = daysOf(v) ?? DEFAULT_DAYS; setDays({ on: days.on, shown: String(n) }); if (days.on) void write(n); }} />
        <span className="text-[12px]" style={{ color: "var(--text2)" }}>days</span>
        <Switch on={days.on} label="Also clean up merged PRs older than" disabled={!root} onChange={flip} />
      </span>{said && <span role="alert" className="text-[11px]" style={{ color: "var(--error-ink)" }}>{said}</span>}</span>} />
  );
}

/** Git & PRs on the new shell. */
export function GitPage({ c }: { c: PageCtx }) {
  const talk = (v: TalkNotify) => { setting("notifications.talk").set(v); c.setTalkMode(v); };
  const ci = (v: boolean) => { setting("notifications.ciOnlyApproved").set(v); c.setCiApproved(v); };
  const gate = (v: boolean) => { setReviewGate(v); c.setReviewGateState(v); };
  return (
    <SettingsPage title="Git & PRs" purpose="What happens after a merge, and which pull requests interrupt you."
      sections={[
        { id: "merge", title: "After a merge", kind: "normal", body: <Section id="merge" title="After a merge"><NoProjectNote /><CleanupDays /><CleanupInclude /><CleanupConfigRows /></Section> },
        { id: "ready", title: "Merge readiness", kind: "normal", body: (
          <Section id="ready" title="Merge readiness">
            <SettingRow kind="control" agentNever="decides whether a reviewer's findings hold a pull request out of the green lane: an agent that could switch it off could clear its own findings from the board" {...row("review.gate")} control={<Switch on={c.reviewGate} label="Review findings block merge-ready pull requests" onChange={(v) => instantSave(c.reviewGate, v, gate)} />} />
          </Section>) },
        { id: "watching", title: "Watching", kind: "normal", body: (
          <Section id="watching" title="Watching">
            <SettingRow kind="control" {...row("notifications.ciOnlyApproved")} control={<Switch on={c.ciApproved} label="Checks fail" onChange={(v) => instantSave(c.ciApproved, v, ci)} />} />
            <SettingRow kind="control" {...row("notifications.talk")} control={<Segmented track label="Conversation" value={c.talkMode} onChange={(v) => instantSave<TalkNotify>(c.talkMode, v, talk)} options={[{ id: "everything", label: "Comments and reviews" }, { id: "reviews", label: "Reviews only" }, { id: "off", label: "Off" }]} />} />
          </Section>) },
      ]} />
  );
}
