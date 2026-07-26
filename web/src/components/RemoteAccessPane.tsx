import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { IS_DESKTOP, remoteAccessEnabled, setRemoteAccess } from "../lib/desktop.ts";
import { qrMatrix, qrSvgPath } from "../lib/qr.ts";
import { fmtAgo } from "../lib/format.ts";
import type { RemoteStatus } from "../../../shared/types.ts";

/**
 * Open the dashboard on your phone.
 *
 * Every piece of this already worked from a terminal — bind off loopback, trust
 * private origins, carry a token — and none of it was reachable from the app,
 * so in practice it existed for people who read the environment table. What
 * this pane adds is the three things a person actually needs:
 *
 *   1. one switch, because the sequence is three variables and a restart;
 *   2. a QR code, because the URL is an IP, a port and a 32-character secret,
 *      typed on glass, once per device;
 *   3. the truth about whether it worked. That last one is why the panel talks
 *      about devices rather than about settings: the server can be bound,
 *      trusted and tokenised, and a host firewall will still drop every packet
 *      silently — the phone shows a white page and nothing anywhere says why.
 *      So the panel waits to *see* a device, and until it does, it names the
 *      firewall on this machine and prints the command that opens the port.
 */
export function RemoteAccessPane({ open }: { open: boolean }) {
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [pick, setPick] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = () => {
      api.remoteStatus().then((r) => { if (live) setSt(r); }).catch(() => { if (live) setSt(null); });
    };
    load();
    remoteAccessEnabled().then((v) => { if (live) setEnabled(v); });
    // Polled while the pane is open, which is what turns "a device connected"
    // into something you watch happen with the phone in your hand.
    const t = setInterval(load, 3000);
    return () => { live = false; clearInterval(t); };
  }, [open]);

  const toggle = async () => {
    setBusy(true);
    // The shell restarts the sidecar and reloads this window, so in the normal
    // case nothing below ever runs. The state update is for the case where it
    // declines.
    const next = await setRemoteAccess(!enabled);
    setBusy(false);
    if (next !== null) setEnabled(next);
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text)
      .then(() => { setCopied(text); setTimeout(() => setCopied(null), 1600); })
      .catch(() => { /* no clipboard permission — the text is on screen anyway */ });
  };

  if (!st) return <Wrap><div className="px-3 py-2 text-[11px] t-dim2">Reading network state…</div></Wrap>;

  const urls = st.urls;
  const url = urls[Math.min(pick, urls.length - 1)] ?? "";
  const address = st.addresses[Math.min(pick, st.addresses.length - 1)];
  const live = st.exposed && st.trustLan && urls.length > 0;

  return (
    <Wrap>
      <div className="px-3 py-2 flex flex-col gap-3">
        <div className="text-[11.5px]" style={{ color: "var(--text2)" }}>
          Open this dashboard on a phone or tablet on the same network. Monitoring, sessions and gate
          approvals, from the sofa.
        </div>

        {enabled === null ? (
          /* A browser tab cannot rebind the server it is talking to: only the
             process that spawned it can. Rather than a switch that would do
             nothing, this is the recipe — the same one the desktop toggle
             performs. */
          <Recipe port={st.port} />
        ) : (
          <button onClick={toggle} disabled={busy} role="switch" aria-checked={!!enabled}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-white/5">
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px]" style={{ color: "var(--text)" }}>Remote access</span>
              <span className="block text-[10.5px] t-dim2 mt-0.5">
                {busy ? "Restarting the server…" : enabled ? "The server is listening on your network" : "Off — the server answers this machine only"}
              </span>
            </span>
            <span className="shrink-0 relative rounded-full transition-colors" style={{
              width: 34, height: 19, opacity: busy ? 0.5 : 1,
              background: enabled ? "color-mix(in srgb, var(--primary) 55%, transparent)" : "color-mix(in srgb, var(--border) 55%, transparent)",
            }}>
              <span className="absolute rounded-full transition-transform" style={{
                width: 15, height: 15, top: 2, left: 2,
                transform: enabled ? "translateX(15px)" : "translateX(0)",
                background: enabled ? "var(--primary-hover)" : "var(--text3)",
              }} />
            </span>
          </button>
        )}

        {/* Turning it on is a real decision, so the consequence is stated in
            the words it deserves rather than as "advanced". */}
        {(enabled || st.exposed) && (
          <div className="text-[10.5px] px-2.5 py-2 rounded-lg" style={{
            color: "var(--text2)",
            background: "color-mix(in srgb, var(--warning) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
          }}>
            Anyone on this network who has the link below gets a terminal, git write access and docker
            control on this machine. Fine at home. Not on café or airport wifi.
          </div>
        )}

        {live && (
          <>
            <div className="flex items-start gap-3">
              <Qr text={url} />
              <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                <div className="text-[10.5px] t-dim2">Scan it with the phone's camera</div>
                <button onClick={() => copy(url)}
                  className="t-mono text-[10.5px] text-left px-2 py-1.5 rounded-lg break-all hover:opacity-80"
                  style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg2) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}>
                  {url}
                </button>
                <div className="text-[10px] t-dim2">
                  {copied === url ? "Copied" : "Tap to copy. The link carries the access code once; after that the phone remembers it."}
                </div>
                {/* More than one route to this machine is normal (wifi plus a
                    tailnet). Naming them beats picking one and being wrong. */}
                {urls.length > 1 && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {st.addresses.map((a, i) => (
                      <button key={a.address} onClick={() => setPick(i)}
                        className="text-[10px] px-2 py-1 rounded-md"
                        style={{
                          color: i === pick ? "var(--primary-hover)" : "var(--text2)",
                          background: i === pick ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "transparent",
                          border: `1px solid color-mix(in srgb, var(--border) ${i === pick ? 60 : 30}%, transparent)`,
                        }}>
                        {a.tailnet ? "Tailscale" : a.iface} · {a.address}
                      </button>
                    ))}
                  </div>
                )}
                {address?.tailnet && (
                  <div className="text-[10px] t-dim2">
                    A tailnet address: reachable from anywhere, but only by devices signed into your Tailscale.
                  </div>
                )}
              </div>
            </div>

            <Devices st={st} onCopy={copy} copied={copied} />
          </>
        )}

        {/* Exposed, but the origin gate is shut: the page would load on the
            phone and every request inside it would 403. Worth its own line,
            because it looks like a broken app rather than a setting. */}
        {st.exposed && !st.trustLan && (
          <div className="text-[10.5px] px-2.5 py-2 rounded-lg" style={{
            color: "var(--warning)",
            background: "color-mix(in srgb, var(--warning) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
          }}>
            The server is bound to {st.bind} but private-network origins are not trusted, so a phone would
            load the page and then be refused by every request in it. Set <span className="t-mono">AGENTGLASS_TRUST_LAN=1</span> as well.
          </div>
        )}

        {!st.webUi && (
          <div className="text-[10.5px] t-dim2">
            This server has no dashboard build to serve, so the address above answers the API only. Run
            <span className="t-mono"> bun run build</span> in the checkout.
          </div>
        )}
      </div>
    </Wrap>
  );
}

/** Same shape as the other settings panes; kept local rather than exported from
 *  SettingsModal, which imports this file. */
function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-2">
      <div className="panel-eyebrow px-3 pb-1">Remote access</div>
      {children}
    </div>
  );
}

/** Proof, or the reason there is none. */
function Devices({ st, onCopy, copied }: { st: RemoteStatus; onCopy: (s: string) => void; copied: string | null }) {
  const { clients, firewall } = st;
  if (clients.count > 0) {
    return (
      <div className="text-[11px] px-2.5 py-2 rounded-lg" style={{
        color: "var(--success)",
        background: "color-mix(in srgb, var(--success) 10%, transparent)",
        border: "1px solid color-mix(in srgb, var(--success) 30%, transparent)",
      }}>
        {clients.count === 1 ? "One device has connected" : `${clients.count} devices have connected`}
        {clients.lastAt ? ` — last seen ${fmtAgo(clients.lastAt)}` : ""}.
        <span className="t-mono t-dim2"> {clients.addresses.slice(0, 3).join(" · ")}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-2 rounded-lg" style={{
      background: "color-mix(in srgb, var(--bg2) 60%, transparent)",
      border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
    }}>
      <div className="text-[11px]" style={{ color: "var(--text2)" }}>
        No device has connected yet. Scan the code; this turns green the moment one arrives.
      </div>
      {firewall && (
        <>
          {/* The failure this exists for: the port is open, the server is
              listening, and the firewall drops the packets without answering —
              so the phone hangs on a blank page and nothing on this machine
              looks wrong. */}
          <div className="text-[10.5px] t-dim2">
            If it stays blank, this machine's firewall ({firewall.tool}) is the likely reason. It drops
            the connection rather than refusing it, which is why the phone shows nothing at all rather
            than an error. Run this in a terminal to let your own network in:
          </div>
          <button onClick={() => onCopy(firewall.command)}
            className="t-mono text-[10px] text-left px-2 py-1.5 rounded-lg break-all hover:opacity-80"
            style={{ color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}>
            {firewall.command}
          </button>
          <div className="text-[10px] t-dim2">
            {copied === firewall.command ? "Copied" : "Tap to copy. agentglass will not run this for you: it needs root, and a dashboard should not have it."}
          </div>
        </>
      )}
    </div>
  );
}

/** The manual route, for a shell that cannot restart its own server. */
function Recipe({ port }: { port: number }) {
  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-2 rounded-lg" style={{
      background: "color-mix(in srgb, var(--bg2) 60%, transparent)",
      border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
    }}>
      <div className="text-[11px]" style={{ color: "var(--text2)" }}>
        Only the process that started the server can change what it listens on, and in a browser tab that
        is not this page. Start it like this instead:
      </div>
      <div className="t-mono text-[10px] px-2 py-1.5 rounded-lg whitespace-pre-wrap" style={{
        color: "var(--text)", background: "color-mix(in srgb, var(--bg) 70%, transparent)",
        border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
      }}>
        {`AGENTGLASS_BIND=0.0.0.0 \\\n  AGENTGLASS_TRUST_LAN=1 \\\n  AGENTGLASS_TOKEN=$(openssl rand -base64 24) \\\n  bun run server   # port ${port}`}
      </div>
      <div className="text-[10px] t-dim2">
        Run <span className="t-mono">bun run build</span> first, so the same port serves the dashboard as
        well as the API. The desktop app has this as a switch.
      </div>
    </div>
  );
}

/** The code itself: one SVG path, on a light plate so a dark theme still scans. */
function Qr({ text }: { text: string }) {
  let path: string;
  let size: number;
  try {
    const m = qrMatrix(text);
    size = m.length;
    path = qrSvgPath(m);
  } catch {
    return null; // longer than version 9 holds; the copyable URL still works
  }
  const quiet = 4; // scanners need the margin, so it is part of the image
  const span = size + quiet * 2;
  return (
    <svg
      width={132} height={132} viewBox={`0 0 ${span} ${span}`} shapeRendering="crispEdges"
      role="img" aria-label={`QR code for ${text}`}
      className="shrink-0 rounded-lg"
      style={{ background: "#fff", padding: 0 }}>
      <path d={path} transform={`translate(${quiet} ${quiet})`} fill="#000" />
    </svg>
  );
}
