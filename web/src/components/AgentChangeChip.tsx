/*
 * "An agent changed a setting, undo", where the person will see it.
 *
 * An agent can write the few settings listed in lib/settingsRegistry.ts through
 * /control, and the one thing that keeps that from being a silent edit of a
 * person's own preferences is that it is never silent: this chip says which
 * setting, what it was and what it is now, and Undo puts it back through the
 * same definition the Settings row uses.
 *
 * Bottom left, because the update card owns bottom right and the two are never
 * the same errand. In a portal at the rung above the Settings dialog: a change
 * made while Settings is open would otherwise be offered behind the very page
 * it changed, with Undo out of reach (measured: the click landed on the dialog). It does not take focus and does not stay: it leaves by
 * itself after CHIP_MS, and the change stays made. One chip at a time, the
 * newest; undoing it shows the one before, if that is still on offer.
 */
import { useEffect, useSyncExternalStore } from "react";
import { settings, shownChange, type SettingValue } from "../lib/settingsRegistry.ts";
import { CloseButton } from "./CloseButton.tsx";
import { HIT } from "../lib/iconSize.ts";
import { LAYER } from "../lib/layers.ts";
import { Portal } from "./Portal.tsx";
import { EDGE } from "./workspace/Chrome.tsx";

/** Long enough to read a sentence and reach for the button; same as the
 *  update card's delay, the other thing that appears by itself. */
export const CHIP_MS = 20_000;

/** A value as a sentence would say it: nothing stored is "default". */
export const say = (v: SettingValue): string => (v === "" ? "default" : typeof v === "boolean" ? (v ? "on" : "off") : String(v));

export function AgentChangeChip() {
  const log = useSyncExternalStore(settings.subscribeChanges, settings.changes, () => []);
  const c = shownChange(log);
  const handle = c?.handle;
  useEffect(() => {
    if (!handle) return;
    const t = setTimeout(() => settings.dismiss(handle), CHIP_MS);
    return () => clearTimeout(t);
  }, [handle]);
  if (!c) return null;
  return (
    <Portal z={LAYER.settingsDialog}>
    <div className="fixed rounded-xl text-left" data-agent-change={c.id}
      style={{
        left: 16, bottom: 16, maxWidth: 360,
        background: "var(--surface-card)", border: EDGE, boxShadow: "0 12px 34px #000a",
        padding: "10px 36px 10px 14px",
      }}
      role="status" aria-live="polite">
      <CloseButton onClick={() => settings.dismiss(c.handle)} title="Dismiss" hit={22} style={{ top: 6, right: 7, color: "var(--text4)" }} className="absolute rounded" />
      <div className="text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>An agent changed {c.label}</div>
      <div className="text-[11.5px] mt-1" style={{ color: "var(--text3)" }}>{say(c.prev)} → {say(c.value)}</div>
      <button onClick={() => settings.undo(c.handle)} className="agx-btn text-[12px] mt-2 px-2.5 rounded-lg"
        style={{ border: EDGE, color: "var(--text2)", minHeight: HIT }}>
        Undo
      </button>
    </div>
    </Portal>
  );
}
