/*
 * The strips and the quiet line the first run draws about the window itself:
 * the port the shell moved to, and the display it draws through.
 */
import { ICON } from "../../lib/iconSize.ts";
import {
  displayLine,
  portNoticeText,
  type PortNotice,
} from "../../lib/setupNotices.ts";

export function PortNoticeBar({ notice, onOpenSettings, onDismiss }: {
  notice: PortNotice;
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {
  const words = portNoticeText(notice);
  return (
    <div className="setup-banner" role="status">
      <span className="setup-banner-ic"><Alert /></span>
      <span className="setup-banner-tx">
        <b>{words.title}</b> {words.body}
      </span>
      <span className="setup-banner-acts">
        <button type="button" className="setup-btn setup-btn-secondary setup-btn-xs" onClick={onOpenSettings}>
          Open Settings › Remote
        </button>
        <button type="button" className="setup-btn setup-btn-quiet setup-banner-x" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          <X />
        </button>
      </span>
    </div>
  );
}

export function DisplayLine({ server }: { server: "wayland" | "x11" | null }) {
  const line = displayLine(server);
  return line ? <p className="setup-hint setup-display">{line}</p> : null;
}

function Alert() {
  return (
    <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.6 14.2 13H1.8L8 2.6Z" />
      <path d="M8 6.4v3.1M8 11.6v.1" />
    </svg>
  );
}

function X() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}
