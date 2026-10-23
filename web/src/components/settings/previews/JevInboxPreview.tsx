import { StatusBadge } from "../../SettingsKit.tsx";
import { PreviewBox, PreviewNote } from "./Frame.tsx";
import { DEMO_INBOX, jevReady, jevRows, removedCounts, sentTitle, type JevMode } from "./logic.ts";

export interface JevInboxPreviewProps {
  hasKey: boolean;
  /** The person agreed the notification title leaves this machine. */
  consent: boolean;
  mode: JevMode;
  /** A row gets "needs you" at or over this probability. */
  threshold: number;
  /** Send the repository name, without its owner. */
  sendRepo: boolean;
  /** Longest title sent, characters. */
  maxTitle: number;
}

/** The Inbox as Jev would leave it, and the exact payload that would leave the machine for one row. */
export function JevInboxPreview(p: JevInboxPreviewProps) {
  if (!jevReady(p.hasKey, p.consent)) {
    return (
      <PreviewBox label="Jev Inbox">
        <div data-preview="jev-inbox" data-state="not-ready" className="rounded-lg p-4 text-[12px]" style={{ background: "var(--bg)", color: "var(--text3)" }}>
          <b style={{ color: "var(--text)" }}>Nothing is scored yet</b>
          <p className="m-0 mt-1">{p.hasKey ? "Tick that the notification title leaves this machine." : "Add your own key, then tick that the notification title leaves this machine."} Until both are done, Jev sees nothing and sends nothing.</p>
        </div>
      </PreviewBox>
    );
  }
  const rows = jevRows(p.mode, p.threshold);
  const live = p.mode === "live";
  const second = DEMO_INBOX[1]!;
  const sent = sentTitle(second.title, p.maxTitle);
  const gone = removedCounts(second.title);
  const repo = second.repo.split("/")[1];
  return (
    <PreviewBox label="Jev Inbox">
      <div data-preview="jev-inbox" data-mode={p.mode} className="rounded-lg overflow-hidden min-w-0" style={{ background: "var(--bg)" }}>
        {p.mode === "off" && <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text3)" }}>Jev is off: the Inbox is exactly as GitHub sent it.</div>}
        {live && <div className="px-3 py-1.5 text-[11px]" style={{ color: "var(--text3)" }}>Sort <b style={{ color: "var(--text)" }}>Needs you first</b></div>}
        {rows.map(({ row, hot }) => (
          <div key={row.title} data-row={hot ? "hot" : ""} className="flex items-center gap-2 px-3 py-2 min-w-0" style={{ background: hot ? "color-mix(in srgb, var(--warning) 9%, transparent)" : undefined }}>
            <i aria-hidden className="shrink-0 rounded-full" style={{ width: 7, height: 7, background: hot ? "var(--warning)" : "var(--text4)" }} />
            <div className="flex-1 min-w-0">
              <div className="truncate text-[12px]" style={{ color: "var(--text)" }}>{row.title}</div>
              <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>{row.repo}</div>
            </div>
            {p.mode !== "off" && <span className="text-[10.5px] tabular-nums" style={{ color: "var(--text3)" }}>{row.p.toFixed(2)}</span>}
            {hot && <StatusBadge tone="warn">needs you</StatusBadge>}
          </div>
        ))}
      </div>
      {p.mode === "shadow" && <PreviewNote>Shadow: scores appear in the Jev flow panel only. The Inbox above is left alone.</PreviewNote>}
      <div className="text-[11px] font-semibold" style={{ color: "var(--text2)" }}>What leaves this machine, for the second row</div>
      <pre data-payload className="m-0 p-3 rounded-lg text-[11px] overflow-x-auto" style={{ background: "var(--surface-inset)", color: "var(--text2)", fontFamily: "var(--font-mono, monospace)" }}>
{`{\n  "title": "${sent.text}${sent.cut ? "…" : ""}",\n  "reason": "${second.reason}"${p.sendRepo ? `,\n  "repo": "${repo}"` : ""}\n}`}
      </pre>
      <PreviewNote>Removed before sending: {gone.links} link, {gone.names} name. Never sent: comments, code, branches, authors, repository owners.</PreviewNote>
    </PreviewBox>
  );
}
