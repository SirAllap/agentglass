/*
 * The pictures the Containers view has besides "a list": not installed,
 * loading, empty, and a daemon that stopped answering. Each says what is true
 * and what to do; none of them is a blank pane.
 */
import type { CSSProperties } from "react";
import { depSpec } from "../../../../shared/deps.ts";
import { RefreshIcon, TerminalIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { CubeIcon } from "./DockerIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { Button } from "../workspace/Chrome.tsx";

const tint = (v: string) => ({ "--tint": v }) as CSSProperties;

/** The binary is missing: install guidance, not the daemon message. */
export function NotInstalled({ reason, onCheck }: { reason?: string; onCheck: () => void }) {
  return (
    <div className="dk-full">
      <div className="dk-card" style={tint("var(--warning)")}>
        <span className="ico"><CubeIcon size={ICON.xl} /></span>
        <b style={{ color: "var(--warning-ink, var(--warning))" }}>Docker isn't installed</b>
        <p>{reason || "The docker CLI isn't on your PATH"}. Containers, images, volumes and logs stay empty until it is.</p>
        {/* Generic on purpose: one macOS, one Windows, an unbounded number of Linux distributions. */}
        <p style={{ color: "var(--text3)", fontSize: 10.5 }}>
          Install it however you install software here (<code>{depSpec("docker")?.url}</code>), then reopen.
          Settings ▸ Requirements checks this and every other tool agentglass uses.
        </p>
        <div className="row"><Button onClick={onCheck}><RefreshIcon size={ICON.sm} />Check again</Button></div>
      </div>
    </div>
  );
}

const SKELETON_ROW = () => (
  <div className="dk-cols dk-r" style={{ cursor: "default" }}>
    <span className="dk-g" />
    <div className="dk-shim"><i style={{ width: "55%" }} /></div>
    <div className="dk-shim"><i /></div><div className="dk-shim"><i /></div>
    <span /><span /><span />
  </div>
);

export function ListSkeleton() {
  return (
    <div style={{ flex: 1, padding: "14px 18px 18px", overflow: "hidden" }} aria-busy="true" aria-label="Loading containers">
      <div className="dk-answers">
        {[0, 1, 2].map((i) => (
          <div key={i} className="dk-ans" style={{ ...tint("var(--text4)"), cursor: "default" } as CSSProperties}>
            <div className="dk-tile" />
            <div className="dk-shim" style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}><i style={{ width: "40%" }} /><i style={{ width: "80%" }} /></div>
          </div>
        ))}
      </div>
      <div className="dk-fmap" style={{ height: 46 }} />
      {[0, 1].map((i) => (
        <div key={i} className="dk-stack">
          <div className="dk-sh"><span /><div className="dk-shim"><i style={{ width: 120 }} /></div><span /><span /><span /></div>
          {[0, 1, 2].map((r) => <SKELETON_ROW key={r} />)}
        </div>
      ))}
    </div>
  );
}

export function EmptyCard({ all, project, onConsole }: { all: boolean; project?: string; onConsole: () => void }) {
  return (
    <div className="dk-full">
      <div className="dk-card" style={tint("var(--info)")}>
        <span className="ico"><CubeIcon size={ICON.xl} /></span>
        <b>No containers yet</b>
        <p>
          {all || !project ? "Nothing is running on this machine." : <>Nothing from <b style={{ fontSize: "inherit" }}>{project}</b> is running.</>}{" "}
          Start the project with <code>docker compose up</code> and it will show up here by itself.
        </p>
        <div className="row"><Button onClick={onConsole}><TerminalIcon size={ICON.sm} />Open the console</Button></div>
      </div>
    </div>
  );
}

/** Last known state stays under it, dimmed; actions are off until the daemon answers. */
export function DaemonBanner({ error, age, onTry }: { error?: string; age?: string; onTry: () => void }) {
  return (
    <div className="dk-banner" role="alert">
      <WarningIcon size={ICON.md} />
      <span>
        <b>Can't reach the Docker daemon.</b> {error ? `${error} ` : ""}
        {age ? `Showing what was there ${age} ago; ` : ""}actions are off until it answers.
      </span>
      <Button size="compact" onClick={onTry}>Try now</Button>
    </div>
  );
}

/** Down with nothing ever seen: there is no last state to dim. */
export function DaemonCard({ error, onTry }: { error?: string; onTry: () => void }) {
  return (
    <div className="dk-full">
      <div className="dk-card" style={tint("var(--warning)")} role="alert">
        <span className="ico"><WarningIcon size={ICON.xl} /></span>
        <b>Can't reach the Docker daemon</b>
        <p>{error || "Connecting to Docker…"} This fills in the moment Docker is back.</p>
        <div className="row"><Button onClick={onTry}><RefreshIcon size={ICON.sm} />Try now</Button></div>
      </div>
    </div>
  );
}
