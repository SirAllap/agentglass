import type { CSSProperties, ReactNode } from "react";
import { Button } from "../workspace/Chrome.tsx";
import { CloseIcon } from "../CloseButton.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { InfoIcon } from "../../lib/glyphIcons.tsx";
import { useEscapeClose } from "../../lib/useDismiss.ts";
import type { FlagTone } from "../../lib/machineView.ts";

const HUE: Record<FlagTone, string> = { muted: "var(--text3)", warn: "var(--warning)", bad: "var(--error)" };
const style = (hue: string) => ({ "--tint": hue }) as CSSProperties;

export function FlagTag({ tone, title, children }: { tone: FlagTone; title?: string; children: ReactNode }) {
  return <span className="mc-tag" style={style(HUE[tone])} title={title}>{children}</span>;
}

/** The dialog's body when there is nothing to list yet: a sentence, or the error. */
export function Pad({ children, error, onRetry }: { children: ReactNode; error?: boolean; onRetry?: () => void }) {
  return (
    <div className="mc-body"><div className="mc-pad" data-err={error || undefined} role={error ? "alert" : "status"}>
      {children}
      {onRetry && <div style={{ marginTop: 10 }}><Button size="compact" onClick={onRetry}>Try again</Button></div>}
    </div></div>
  );
}

export function Group({ label, count, hint, lead }: { label: string; count: number; hint?: string; lead?: ReactNode }) {
  return <div className="mc-gh"><span className="lead">{lead}{label}</span>{hint && <span className="hint">{hint}</span>}<span className="n">{count}</span></div>;
}

/** An action's answer, above the list, with a way to put it away. */
export function ActionNote({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  return (
    <div className="mc-note" style={style("var(--primary)")} role="status">
      <InfoIcon size={ICON.sm} />{children}
      <span className="x"><Button size="compact" square tone="quiet" label="Dismiss" onClick={onDismiss}><CloseIcon size={ICON.xs} /></Button></span>
    </div>
  );
}

/** "Stop it" / "Keep", mounted only while a stop is armed, so Esc means "keep it" exactly then. */
export function StopConfirm({ pid, onYes, onNo }: { pid: number; onYes: () => void; onNo: () => void }) {
  useEscapeClose(onNo);
  return (<>
    <Button size="compact" tone="danger" autoFocus title={`Send SIGTERM to pid ${pid}`} onClick={onYes}>Stop it</Button>
    <Button size="compact" tone="quiet" title="Keep it" onClick={onNo}>Keep</Button>
  </>);
}
