import { useEffect, useRef } from "react";
import { api } from "../lib/api.ts";
import { clientId, onBrowserTabs, serveBrowserAsk, setBrowserAskHandler } from "../lib/browserBus.ts";
import type { DrivableWebview } from "../lib/browserDrive.ts";
import { BLANK } from "../lib/browserPrefs.ts";
import { normalizeNavigationUrl } from "../lib/browserUrl.ts";
import { partitionFor } from "../lib/browserProfiles.ts";
import { BROWSER_PARTITION } from "../lib/desktop.ts";
import { useLive } from "../lib/useLive.ts";

/**
 * The whole page of a lane host: one webview and the browser ask handler.
 *
 * Asks go straight to `serveBrowserAsk`, the same path the Browser panel's
 * handler ends in, so every verb runs through the unchanged driver. What the
 * panel adds on top — tabs, containers, the cross-container refusal — is not
 * here: one webview, in the container the lane was made for (`profile`: the
 * person's own, a named one, or one that is this lane's alone). The tab verbs
 * see exactly one tab, so `open` lands in it, and an ask naming any other tab
 * is refused rather than served from this one.
 *
 * `ephemeral` (S6, `lane new --from-template`): an in-memory jar of its own,
 * checked before `profile` so a lane with no profile string still never falls
 * through to `partitionFor`'s empty-string case, which is the person's own
 * cookies. Its partition string is built again here rather than imported: it
 * is CommonJS in electron/guest-guard.js (`ephemeralPartition`), which this
 * renderer bundle cannot require() — the same reason `shared/csp.ts`'s list
 * is a documented copy in main.js rather than an import. Keep the two in
 * sync by hand if the shape in guest-guard.js's `EPHEMERAL_PARTITION_RE` ever
 * changes.
 */
export function LaneHost({ id, profile, ephemeral = false }: { id: string; profile: string; ephemeral?: boolean }) {
  // The live socket is what carries the asks; its data is not used here.
  useLive();
  const view = useRef<HTMLElement | null>(null);

  const tab = `lane-${id}`;
  useEffect(() => {
    const el = () => view.current as unknown as DrivableWebview | null;
    const off = onBrowserTabs({
      list: () => {
        const v = el();
        return [{ id: tab, title: v?.getTitle() ?? "", url: v?.getURL() ?? "", active: true }];
      },
      select: (which) => which.id === tab || which.index === 0,
      open: (url, asked) => {
        if (asked && asked !== "default") return { error: "a lane has one container, the one it was made for" };
        const to = !url || url === BLANK ? BLANK : normalizeNavigationUrl(url);
        if (!to) return { error: "a lane opens http and https pages only" };
        void el()?.loadURL(to).catch(() => { /* the next verb reports the page state */ });
        return { id: tab };
      },
      close: () => false,
      profiles: () => ["default"],
    });
    setBrowserAskHandler((ask) => {
      const page = ask.args.page;
      if (typeof page === "string" && page !== tab) {
        void api.browserResult({ client: clientId(), id: ask.id, ok: false, error: `no tab called ${page} in this lane; its one tab is ${tab}` })
          .catch(() => { /* already timed out */ });
        return;
      }
      void serveBrowserAsk(el(), ask);
    });
    return () => { setBrowserAskHandler(null); off(); };
  }, [tab]);

  /* Registered as the host of THIS lane, and only of it: a registration with no
     lane is the main window's role, which would make every ask meant for the
     person's view land here. */
  useEffect(() => {
    const me = clientId();
    const beat = () => { void api.browserReady(me, true, [id]).catch(() => {}); };
    beat();
    // Liveness, not UI refresh: server/src/lanes.ts drops a lane whose host stops beating
    // after HOST_GONE_MS (60 s), so this must keep running while the window is hidden.
    const timer = setInterval(beat, 30_000);
    return () => {
      clearInterval(timer);
      void api.browserReady(me, false, [id]).catch(() => {});
    };
  }, [id]);

  const partition = ephemeral ? `agentglass-browser-eph-${id}` : partitionFor(BROWSER_PARTITION, profile);
  return (
    <webview
      ref={view as unknown as React.Ref<HTMLElement>}
      data-lane={id}
      src={BLANK}
      partition={partition}
      style={{ width: "100vw", height: "100vh", display: "inline-flex" }}
    />
  );
}
