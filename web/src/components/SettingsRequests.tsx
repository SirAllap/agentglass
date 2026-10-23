/*
 * "An agent asks to change a setting": the person's one click, Approve or Decline.
 *
 * Drawn in the corner every agent chip shares (AgentChangeChip.tsx), on the same
 * card (AGENT_CARD), so a request reads as one of that family. Every word on it
 * is the server's: who asked as the server knows them, the setting's label, and
 * the diff it computed from the value it validated (server/src/settingsDoor.ts).
 * Nothing the agent wrote reaches this card as a sentence; a value it asked for
 * is shown as JSON, as data. Approve applies that diff and grants nothing for
 * next time. A request nobody answers is declined when it expires, and the card
 * goes when the server says so.
 */
import { useState, useSyncExternalStore } from "react";
import { settingsRequests, answerSettingsRequest } from "../lib/settingsRequests.ts";
import { AGENT_BTN, AGENT_CARD } from "./AgentOffers.tsx";
import { HIT } from "../lib/iconSize.ts";
import type { SettingRequestView } from "../../../shared/settingClass.ts";

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function RequestCard({ r }: { r: SettingRequestView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (approve: boolean) => {
    setBusy(true);
    setError(await answerSettingsRequest(r.id, approve));
    setBusy(false);
  };
  const [title, ...lines] = r.diff;
  return (
    <div className="rounded-xl text-left" data-settings-request={r.setting} style={{ ...AGENT_CARD, padding: "12px 14px" }} role="alertdialog" aria-label={`${r.who} asks to change ${r.label}`}>
      <div className="text-[13.5px] font-semibold" style={{ color: "var(--text)", overflowWrap: "anywhere" }}>{r.who} asks to change a setting</div>
      <div className="text-[12px] mt-1" style={{ color: "var(--text2)", overflowWrap: "anywhere" }}>{title}</div>
      <div className="text-[11.5px] mt-1 font-mono overflow-auto" style={{ color: "var(--text3)", maxHeight: 120, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{lines.join("\n")}</div>
      <div className="text-[11.5px] mt-1" style={{ color: "var(--text4)" }}>Declined by itself at {clock(r.expires)} if you do not answer.</div>
      {error && <div className="text-[12px] mt-1" style={{ color: "var(--error-ink)" }}>{error}</div>}
      <div className="flex gap-2 mt-2">
        <button disabled={busy} onClick={() => void answer(true)} className="agx-btn text-[12px] px-2.5 rounded-lg font-medium" style={AGENT_BTN}>Approve</button>
        <button disabled={busy} onClick={() => void answer(false)} className="agx-btn text-[12px] px-2.5 rounded-lg" style={{ minHeight: HIT, color: "var(--text2)" }}>Decline</button>
      </div>
    </div>
  );
}

export function useSettingsRequests(): readonly SettingRequestView[] {
  return useSyncExternalStore(settingsRequests.subscribe, settingsRequests.list, () => []);
}

/** The oldest few, and a line for the rest: twenty cards would climb off the screen.
 *  Answering one brings the next up. */
export function SettingsRequestsList({ requests, max }: { requests: readonly SettingRequestView[]; max: number }) {
  const more = requests.length - max;
  return (
    <>
      {requests.slice(0, max).map((r) => <RequestCard key={r.id} r={r} />)}
      {more > 0 && <div className="text-[12px] rounded-xl" style={{ ...AGENT_CARD, padding: "8px 14px", color: "var(--text3)" }}>{more} more {more === 1 ? "request waits" : "requests wait"} behind these</div>}
    </>
  );
}
