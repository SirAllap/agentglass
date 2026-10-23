import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { openSettings } from "../../lib/openSettings.ts";
import type { PublicPlugin } from "../../../../shared/types.ts";
import { PluginWhyStopped } from "./PluginWhyStopped.tsx";
import { Button, LINE } from "../workspace/Chrome.tsx";

/**
 * What a panel says when the plugin that draws it is not running. One
 * sentence for every kind of panel: a tree shows it in place of the tree, a
 * live canvas shows it as a bar over the scene it last had.
 */
export function PluginNotRunning({ plugin, bar }: { plugin: string; bar?: boolean }) {
  // One read when the panel turns up: the reason is a few lines, not a feed.
  const [why, setWhy] = useState<Pick<PublicPlugin, "lastExit" | "lastBoxFailure"> | null>(null);
  useEffect(() => {
    let live = true;
    api.plugins().then((r) => { const p = r.plugins.find((x) => x.name === plugin); if (live && p) setWhy(p); }).catch(() => { /* no reason shown */ });
    return () => { live = false; };
  }, [plugin]);
  if (bar) {
    return (
      <div role="status" className="flex items-center gap-3 px-3 py-2 rounded-xl" style={{ background: "var(--surface-card)", border: LINE }}>
        <span className="text-[12px] font-medium min-w-0 flex-1" style={{ color: "var(--text2)" }}>{plugin} is not running</span>
        <Button size="compact" onClick={() => openSettings("plugins")}>Open plugin settings</Button>
      </div>
    );
  }
  return (
    <div className="flex-1 h-full min-h-[240px] flex items-center justify-center">
      <div className="flex flex-col items-center gap-2 text-center max-w-[48ch]">
        <div className="text-[13px] font-medium" style={{ color: "var(--text2)" }}>{plugin} is not running</div>
        <div className="text-[12px]" style={{ color: "var(--text3)" }}>
          Its panel is drawn by its own process, and there is none right now. Enable it again in Settings; if it
          keeps stopping, the plugin exited on its own.
        </div>
        <Button onClick={() => openSettings("plugins")} className="mt-1">Open plugin settings</Button>
        {why && <div className="mt-2 w-full text-left"><PluginWhyStopped plugin={why} /></div>}
      </div>
    </div>
  );
}
