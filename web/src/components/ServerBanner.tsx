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
// Only the run-from-source path can get here. The desktop shell has probed the
// port since #126, and a single-port deploy is talking to itself by definition.
import { useEffect, useState } from "react";
import { IS_DEMO, SERVER, SERVER_GUESSED, probeServer, type ServerIdentity } from "../lib/api.ts";

/** How often to look again while the answer is wrong. Often enough that
 *  starting the server clears the banner without a reload, rare enough that a
 *  machine with nothing listening is not hammering a closed port. */
const RECHECK_MS = 4000;

export default function ServerBanner() {
  const [identity, setIdentity] = useState<ServerIdentity>("ours");

  useEffect(() => {
    // Nothing to warn about when the origin was configured rather than guessed,
    // and the demo has no server at all by design.
    if (!SERVER_GUESSED || IS_DEMO) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const look = async () => {
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

  if (identity === "ours") return null;

  // Two different problems, two different fixes. Telling them apart is most of
  // the value here — "start the server" and "something else owns this port"
  // have looked identical from this screen until now.
  const foreign = identity === "foreign";
  return (
    <div
      role="alert"
      className="shrink-0 px-4 py-2 text-[11px] flex items-center gap-2 flex-wrap border-b"
      style={{
        background: foreign
          ? "color-mix(in srgb, var(--error) 14%, transparent)"
          : "color-mix(in srgb, var(--warning) 12%, transparent)",
        borderColor: foreign
          ? "color-mix(in srgb, var(--error) 35%, transparent)"
          : "color-mix(in srgb, var(--warning) 30%, transparent)",
        color: "var(--text)",
      }}
    >
      <span className="font-semibold" style={{ color: foreign ? "var(--error)" : "var(--warning)" }}>
        {foreign ? "Wrong server" : "No server"}
      </span>
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
    </div>
  );
}
