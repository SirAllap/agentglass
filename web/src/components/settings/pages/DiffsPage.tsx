import { useState } from "react";
import { setting } from "../../../lib/settingsRegistry.ts";
import { diffGroupBy, diffShowIgnored, diffShowOutside } from "../../../lib/diffPrefs.ts";
import { THEMES } from "../../../lib/highlight.ts";
import { Select } from "../../Select.tsx";
import { Segmented } from "../../workspace/Chrome.tsx";
import { Switch } from "../../orchestration/flow/Switch.tsx";
import { DiffPreview } from "../previews/index.ts";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { instantSave } from "../save/index.ts";
import { DIFF_ROWS } from "./pageRows.ts";
import type { PageCtx } from "./ctx.ts";

const COPY = Object.fromEntries(DIFF_ROWS.map((r) => [r.id, r]));
const row = (id: string) => ({ label: COPY[id].label, help: COPY[id].help });
type Group = "worktree" | "time" | "folder";

/** Diffs on the new shell: one section with the real Diff view as its preview block. */
export function DiffsPage({ c }: { c: PageCtx }) {
  const [gBy, setGBy] = useState<Group>(diffGroupBy);
  const [ign, setIgn] = useState(diffShowIgnored);
  const [out, setOut] = useState(diffShowOutside);
  const split = (v: "split" | "inline") => { setting("diff.split").set(v); c.setDSplitState(v === "split"); };
  const theme = (v: string) => { setting("diff.syntaxTheme").set(v); c.setDThemeState(v); };
  const wrap = (v: boolean) => { setting("diff.wrap").set(v); c.setDWrapState(v); };
  const group = (v: Group) => { setting("diff.groupBy").set(v); setGBy(v); };
  const ignore = (v: boolean) => { setting("diff.showIgnored").set(v); setIgn(v); };
  const outside = (v: boolean) => { setting("diff.showOutside").set(v); setOut(v); };
  const view = c.dSplit ? "split" : "inline";
  return (
    <SettingsPage title="Diffs" purpose="How a diff opens and how it reads."
      sections={[
        { id: "open", title: "How a diff opens", kind: "normal", body: (
          <Section id="open" title="How a diff opens" preview={<DiffPreview split={c.dSplit} wrap={c.dWrap} syntaxTheme={c.dTheme} />}>
            <SettingRow kind="control" {...row("diff.split")} control={<Segmented track label="Default view" value={view} onChange={(v) => instantSave<"split" | "inline">(view, v, split)} options={[{ id: "split", label: "Split" }, { id: "inline", label: "Inline" }]} />} />
            <SettingRow kind="control" {...row("diff.syntaxTheme")} control={<Select align="right" value={c.dTheme} onChange={(v) => instantSave(c.dTheme, v, theme)} options={[{ value: "auto", label: "Auto (app theme)" }, ...THEMES.map((t) => ({ value: t.id, label: t.label, hint: t.dark ? "Dark" : "Light" }))]} />} />
            <SettingRow kind="control" {...row("diff.groupBy")} control={<Segmented track label="Group by" value={gBy} onChange={(v) => instantSave<Group>(gBy, v, group)} options={[{ id: "worktree", label: "Worktree" }, { id: "time", label: "Time" }, { id: "folder", label: "Folder" }]} />} />
            <SettingRow kind="control" {...row("diff.showIgnored")} control={<Switch on={ign} label="Show ignored" onChange={(v) => instantSave(ign, v, ignore)} />} />
            <SettingRow kind="control" {...row("diff.showOutside")} control={<Switch on={out} label="Show outside the worktree" onChange={(v) => instantSave(out, v, outside)} />} />
            <SettingRow kind="control" {...row("diff.wrap")} control={<Switch on={c.dWrap} label="Wrap long lines" onChange={(v) => instantSave(c.dWrap, v, wrap)} />} />
          </Section>) },
      ]} />
  );
}
