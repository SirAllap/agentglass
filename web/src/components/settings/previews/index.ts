import type { ComponentType } from "react";
import { WindowPreview } from "./WindowPreview.tsx";
import { AppearancePreview } from "./AppearancePreview.tsx";
import { SidebarPreview } from "./SidebarPreview.tsx";
import { DiffPreview } from "./DiffPreview.tsx";
import { LanternPreview } from "./LanternPreview.tsx";
import { BrowserPreview } from "./BrowserPreview.tsx";
import { OrchestrationPreview } from "./OrchestrationPreview.tsx";
import { JevInboxPreview } from "./JevInboxPreview.tsx";
import { ContextDietPreview } from "./ContextDietPreview.tsx";
import { LocalReviewPreview } from "./LocalReviewPreview.tsx";

/**
 * Pane id -> the preview that page mounts in its preview slot, and the props it
 * reads (the page passes its CURRENT values, so the picture follows each
 * control as it moves). Plugin settings pages are keyed by the plugin's id.
 * Optional props are marked `?`.
 *
 *   <PagePreview id="diff" split={split} wrap={wrap} />  ->  PREVIEWS.diff.component
 */
export const PREVIEWS = {
  prefs: { component: WindowPreview, props: ["zoomPct", "fullscreen", "startAtLogin", "launchAnimation", "showClock", "codexQuota", "view", "rail?"] },
  appearance: { component: AppearancePreview, props: ["theme", "accent", "density", "fontPx", "translucent", "view", "rail?"] },
  rail: { component: SidebarPreview, props: ["items", "selected", "view?"] },
  diff: { component: DiffPreview, props: ["split", "wrap", "syntaxTheme?"] },
  lantern: { component: LanternPreview, props: ["watch", "everyMin", "wakeMin"] },
  browser: { component: BrowserPreview, props: ["home", "searchEngine"] },
  orchestration: { component: OrchestrationPreview, props: ["policy", "readiness", "root", "limited?", "facts?"] },
  "jev-inbox": { component: JevInboxPreview, props: ["hasKey", "consent", "mode", "threshold", "sendRepo", "maxTitle"] },
  "context-diet": { component: ContextDietPreview, props: ["cap", "countSubagents", "windowDays"] },
  "local-review": { component: LocalReviewPreview, props: ["agent", "model", "capUsd"] },
} as const satisfies Record<string, { component: ComponentType<never>; props: readonly string[] }>;

export type PreviewId = keyof typeof PREVIEWS;
export { WindowPreview, AppearancePreview, SidebarPreview, DiffPreview, LanternPreview, BrowserPreview, OrchestrationPreview, JevInboxPreview, ContextDietPreview, LocalReviewPreview };
export { LiveTabs, LIVE_VIEWS, type LiveView } from "./LiveWindow.tsx";
export { previewVars } from "./previewTheme.ts";
export type { RailItem, Density, JevMode, CapLabel } from "./logic.ts";
