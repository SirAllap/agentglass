import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.ts";
import type { PluginPanel, UiAction } from "../../lib/pluginTypes.ts";
import { subscribePluginFrame } from "../../lib/pluginBus.ts";
import { openSettings } from "../../lib/openSettings.ts";
import { ICON } from "../../lib/iconSize.ts";
import { Spinner } from "../Spinner.tsx";
import { PluginTree } from "./PluginTree.tsx";
import { PluginCanvas } from "./PluginCanvas.tsx";
import { PluginNotRunning } from "./PluginNotRunning.tsx";
import { PanelGlyph } from "./panelGlyph.tsx";
import { PluginMark } from "./PluginMark.tsx";
import { Button, LINE, Tabs } from "../workspace/Chrome.tsx";

/**
 * The rail's home for plugins: every panel an enabled plugin declared, one
 * at a time, drawn by PluginTree, or by PluginCanvas when the panel declared
 * itself a live canvas (a scene the plugin changes many times a second, over
 * its own socket rather than re-posted as a tree).
 *
 * One view for all of them rather than a rail entry per panel. The rail is a
 * compiled list with hotkeys people already have in their fingers, and a
 * plugin appearing there would renumber them; here a new panel is a new tab
 * and nothing else moves. A rail entry per plugin is the next thing after
 * this and is not here.
 */

const PICK_KEY = "agentglass-plugin-panel";

function readPick(): string | null {
  try { return localStorage.getItem(PICK_KEY); } catch { return null; }
}
function savePick(k: string): void {
  try { localStorage.setItem(PICK_KEY, k); } catch { /* per-viewer nicety only */ }
}

const keyOf = (p: PluginPanel) => `${p.plugin}/${p.id}`;

export function PluginsView({ active }: { active: boolean }) {
  const [panels, setPanels] = useState<PluginPanel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(readPick);

  const load = useCallback(async () => {
    try {
      const r = await api.pluginPanels();
      setPanels(r.panels);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { if (active) void load(); }, [active, load]);
  // A redraw is announced as "look again", naming the panel. Only while this
  // view is on screen, and only that panel: a plugin drawing progress every
  // second must not make every window re-download every tree. A burst is
  // coalesced into one fetch per panel. Anything missed while hidden is
  // caught by the full load when the view comes back.
  useEffect(() => {
    if (!active) return;
    const due = new Map<string, ReturnType<typeof setTimeout>>();
    const off = subscribePluginFrame((f) => {
      if (f.kind !== "panels") return;
      const k = f.plugin && f.panel ? `${f.plugin}/${f.panel}` : "*";
      const t0 = due.get(k);
      if (t0) clearTimeout(t0);
      due.set(k, setTimeout(async () => {
        due.delete(k);
        if (k === "*") { void load(); return; }
        try {
          const r = await api.pluginPanels(f.plugin, f.panel);
          const fresh = r.panels[0];
          if (!fresh) { void load(); return; }
          setPanels((ps) => ps?.map((p) => (keyOf(p) === keyOf(fresh) ? fresh : p)) ?? ps);
        } catch { /* the next ping or the next visit catches up */ }
      }, 120));
    });
    return () => { off(); for (const t of due.values()) clearTimeout(t); };
  }, [active, load]);

  const current = useMemo(() => {
    if (!panels?.length) return null;
    return panels.find((p) => keyOf(p) === pick) ?? panels[0]!;
  }, [panels, pick]);

  const choose = (p: PluginPanel) => { setPick(keyOf(p)); savePick(keyOf(p)); };

  const onAction = useCallback(async (action: UiAction, values?: Record<string, unknown>) => {
    if (!current) return;
    const r = await api.pluginAction(current.plugin, current.id, action, values);
    if (!r.ok) setError(r.error ?? "the plugin did not take that");
  }, [current]);

  if (panels === null) {
    return <Centered><Spinner label="Loading plugins…" /></Centered>;
  }

  if (panels.length === 0) {
    return (
      <Centered>
        <div className="flex flex-col items-center gap-3 text-center max-w-[52ch] px-6">
          <span style={{ color: "var(--text3)" }}><PanelGlyph icon="puzzle" size={ICON.xl} /></span>
          <div className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>No plugin draws here yet</div>
          <div className="text-[12px] leading-relaxed" style={{ color: "var(--text3)" }}>
            A plugin can add a panel to this view, a page to Settings and local notes to a pull request. It draws
            with this app's own parts and never runs inside the window. Install one and enable it to see it here.
          </div>
          <Button tone="primary" onClick={() => openSettings("plugins")} className="mt-1">Browse plugins</Button>
        </div>
      </Centered>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex items-center gap-2 px-4 h-[44px] shrink-0 min-w-0"
        style={{ borderBottom: LINE, background: "var(--surface-nav)" }}>
        <div className="min-w-0 overflow-x-auto flex-1">
          <Tabs<string> label="Plugin panels" panelId="plugin-panel" value={current ? keyOf(current) : ""}
            onChange={(k) => { const p = panels.find((q) => keyOf(q) === k); if (p) choose(p); }}
            options={panels.map((p) => ({
              id: keyOf(p),
              title: `${p.title} — ${p.plugin} by ${p.publisher}`,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  {p.hasIcon || p.color
                    ? <PluginMark name={p.plugin} icon={p.hasIcon ? "icon" : undefined} color={p.color ?? undefined} size={ICON.lg} stamp={p.stamp} />
                    : <PanelGlyph icon={p.icon} size={ICON.sm} />}
                  {p.title}
                  {!p.running && <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--text4)" }} title="not running" />}
                </span>
              ),
            }))} />
        </div>
        {current && (
          <div className="flex items-center gap-2 shrink-0 text-[10.5px]" style={{ color: "var(--text3)" }}>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: current.running ? "var(--success)" : "var(--text4)" }} />
              {current.plugin}
            </span>
            <span style={{ color: "var(--text4)" }}>·</span>
            <span className="truncate max-w-[18ch]" title={`Published by ${current.publisher} — not verified`}>{current.publisher}</span>
            <Button size="compact" onClick={() => openSettings(`plugin:${current.plugin}`)} className="ml-1">Settings</Button>
          </div>
        )}
      </header>
      {error && (
        <div className="px-4 py-1.5 text-[11px] shrink-0" style={{ color: "var(--error-ink)", background: "color-mix(in srgb, var(--error) 8%, transparent)" }}>
          {error}
        </div>
      )}
      {/* A live canvas keeps its scrollbar's room: a board scales with the
          width, and a scrollbar arriving with a longer list below it would
          shrink the board and move everything under it by a few pixels. */}
      <div id="plugin-panel" role="tabpanel" className="flex-1 min-h-0 overflow-auto" style={current?.canvas ? { scrollbarGutter: "stable" } : undefined}>
        <div className="p-4 min-h-full flex flex-col">
          {current?.canvas ? (
            <PluginCanvas key={keyOf(current)} plugin={current.plugin} panel={current.id} running={current.running} onAction={onAction} />
          ) : current && !current.running ? (
            <PluginNotRunning plugin={current.plugin} />
          ) : current && !current.tree ? (
            <Centered><Spinner label={`Waiting for ${current.plugin} to draw…`} /></Centered>
          ) : current?.tree ? (
            <PluginTree key={keyOf(current)} node={current.tree} onAction={onAction} version={current.updatedAt ?? 0} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 h-full min-h-[240px] flex items-center justify-center">{children}</div>;
}
