// Says out loud what the UI is talking to, when what it is talking to is wrong.
//
// The dashboard's API origin is configured three ways and guessed a fourth:
// `VITE_CW_SERVER`, the origin the desktop shell verified and handed over, the
// server having served the page itself — and, failing all three,
// `http://<host>:4000`. That last one is a guess, and nothing used to check it.
//
// When the guess is wrong the app does not fail, which is the problem. Requests
// go to whoever owns the port, come back as 404s or shapes we do not
// understand, and the cockpit renders exactly as it would with no agents: empty
// panels, "no repos found", no error anywhere. The honest reading of that
// screen is "this project is broken".
//
// TWO SOURCES, because the origin being CONFIGURED never meant it was ALIVE.
// This file used to stop at the first line of its effect — `if (!SERVER_GUESSED)
// return` — on the grounds that the desktop shell probes the port. It does, and
// that is a different claim: the shell probes to PICK a port and then spawns a
// sidecar into it. When that spawn failed there was no server, no banner (the
// guard above is false in the packaged app, always, because api.ts sets
// SERVER_GUESSED from DESKTOP_API), and nothing on screen but a CLOSED pill in
// the header. So the shell now reports its own failures and they are rendered
// here, with the reason and the fix, beside the guess-check that came first.
import { useEffect, useState } from "react";
import { IS_DEMO, SERVER, SERVER_GUESSED, probeServer, sidecarFailure, onSidecarFailure, type ServerIdentity, type SidecarFailure, whenServerUp } from "../lib/api.ts";

/** How often to look again while the answer is wrong. Often enough that
 *  starting the server clears the banner without a reload, rare enough that a
 *  machine with nothing listening is not hammering a closed port. */
const RECHECK_MS = 4000;

export default function ServerBanner() {
  const [identity, setIdentity] = useState<ServerIdentity>("ours");
  // Seeded from the shell rather than left null, so a window that opened after
  // the give-up — a reload, a second window — shows the banner on its first
  // paint instead of waiting for an event that has already been and gone.
  const [shell, setShell] = useState<SidecarFailure | null>(() => sidecarFailure());

  useEffect(() => {
    // Nothing to warn about when the origin was configured rather than guessed,
    // and the demo has no server at all by design.
    if (!SERVER_GUESSED || IS_DEMO) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const look = async () => {
      // The gate first, then the probe. Asking the network before the shell
      // has a server is one refused /health per launch — and this component's
      // whole job is to report a server that is NOT coming, which the gate
      // already waits for and releases on.
      await whenServerUp();
      const now = await probeServer();
      if (stop) return;
      setIdentity(now);
      // Stop asking once it is us: the socket takes over from here, and a
      // healthy app should not be polling /health forever.
      if (now !== "ours") timer = setTimeout(look, RECHECK_MS);
    };
    void look();
    return () => { stop = true; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    // Both directions. The shell sends null when a sidecar finally answers — a
    // slow start, or the restart that flipping remote access performs — and a
    // banner that only ever appeared would then be a permanent lie.
    if (IS_DEMO) return;
    return onSidecarFailure(setShell);
  }, []);

  if (shell) return <ShellBanner failure={shell} />;
  if (identity === "ours") return null;

  // Two different problems, two different fixes. Telling them apart is most of
  // the value here — "start the server" and "something else owns this port"
  // have looked identical from this screen until now.
  const foreign = identity === "foreign";
  return (
    <Bar tone={foreign ? "error" : "warning"} label={foreign ? "Wrong server" : "No server"}>
      {foreign ? (
        <span>
          Something is listening on <code>{SERVER}</code>, but it isn’t agentglass — everything below is empty because
          that server has nothing to say about your agents.
        </span>
      ) : (
        <span>
          Nothing is answering at <code>{SERVER}</code>.
        </span>
      )}
      <span style={{ color: "var(--text3)" }}>
        Start it with <code>bun run dev</code>, or point the UI elsewhere with <code>VITE_CW_SERVER</code>.
      </span>
    </Bar>
  );
}

/**
 * The desktop shell's version: it knows exactly what went wrong, so it says so.
 *
 * A broken install, a port somebody else holds and a crash on the first line
 * are three different problems with three different fixes, and from inside the
 * app they used to look like one — an app that had simply come up empty.
 */
function ShellBanner({ failure }: { failure: SidecarFailure }) {
  // A missing program is a broken install and cannot resolve itself; the rest
  // might still be starting or might be fixed by a restart, so they are the
  // softer colour. The words carry the difference either way.
  const hard = failure.reason === "missing" || failure.reason === "spawn";
  return (
    <Bar tone={hard ? "error" : "warning"} label="No server">
      <span>{failure.what}</span>
      {failure.where ? <code>{failure.where}</code> : null}
      <span style={{ color: "var(--text3)" }}>{failure.fix}</span>
      {/* The server's own last words. Truncated by the shell, not here, and
          shown as-is: it is the only text in this banner that names the real
          cause when the cause is not one of the four we can classify. */}
      {failure.detail ? (
        <code className="opacity-70 max-w-full truncate" title={failure.detail}>{failure.detail}</code>
      ) : null}
    </Bar>
  );
}

/** The row itself, shared so the two callers cannot drift apart on colour or
 *  spacing — they already had, once, when this was two copies. */
function Bar({ tone, label, children }: { tone: "error" | "warning"; label: string; children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="shrink-0 px-4 py-2 text-[11px] flex items-center gap-2 flex-wrap border-b"
      style={{
        background: `color-mix(in srgb, var(--${tone}) ${tone === "error" ? 14 : 12}%, transparent)`,
        borderColor: `color-mix(in srgb, var(--${tone}) ${tone === "error" ? 35 : 30}%, transparent)`,
        color: "var(--text)",
      }}
    >
      <span className="font-semibold" style={{ color: `var(--${tone})` }}>{label}</span>
      {children}
    </div>
  );
}
