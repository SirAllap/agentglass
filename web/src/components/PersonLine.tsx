import type { ReactNode } from "react";
import { subline, type PersonSource } from "../lib/personRow.ts";

/**
 * A person in a list: the name, and under it what tells two people with the
 * same name apart — the email when the source gives one, else the login and
 * the system it came from. See lib/personRow.ts for why it is never the name.
 */
export function PersonLine({ name, email, login, source, sub, muted }: {
  /** A node rather than a string so the search box's highlight fits through. */
  name: ReactNode;
  email?: string;
  login?: string;
  source?: PersonSource;
  /** What the row already had to say: a verdict, a reason, why it is disabled. */
  sub?: string;
  muted?: boolean;
}) {
  const line = subline({ email, login, source, sub });
  return (
    <div className="flex-1 min-w-0 grid">
      <b className="text-[12.5px] font-medium truncate" style={{ color: "var(--text)" }}>{name}</b>
      {line && <small className="text-[11px] truncate" style={{ color: muted ? "var(--text4)" : "var(--text3)" }}>{line}</small>}
    </div>
  );
}
