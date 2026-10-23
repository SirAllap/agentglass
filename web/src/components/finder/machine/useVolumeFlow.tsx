// What the DEVICES rows do when pressed, and the two dialogs that can follow.
// The decisions (which button, what a click means, the titles) are in
// lib/finderVolumes.ts and tested there; this only runs them.
import { useCallback, useRef, useState, type ReactNode } from "react";
import { api } from "../../../lib/api.ts";
import { resolveAddress } from "../../../lib/finderRemote.ts";
import { FAILED, clickOf, failedTitle, stepDialog, useVolumes } from "../../../lib/finderVolumes.ts";
import type { NetworkList, RemoteStep, Volume } from "../../../../../shared/types.ts";
import type { VolumeAsk } from "./Sidebar.tsx";
import { ConnectDialog, ErrorDialog, NetworkDialog, PassphraseDialog } from "./VolumeDialogs.tsx";

export function useVolumeFlow({ here, home, go, on = true }: { here: string; home: string; go: (path: string) => void; on?: boolean }) {
  const { volumes, reload } = useVolumes(on);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [ask, setAsk] = useState<{ v: Volume; wrong: boolean } | null>(null);
  const [failed, setFailed] = useState<{ title: string; message: string } | null>(null);
  const [net, setNet] = useState<NetworkList | null>(null);
  const [conn, setConn] = useState<{ step: Extract<RemoteStep, { state: "password" | "question" }>; busy: boolean } | null>(null);
  const running = useRef(new Set<string>());

  const work = useCallback(async (v: Volume, act: keyof typeof FAILED, passphrase?: string) => {
    if (running.current.has(v.id)) return null;
    running.current.add(v.id); setBusy(new Set(running.current));
    try {
      const r = await api.volumeAct(act, v.id, passphrase);
      reload();
      return r;
    } catch { return { ok: false, error: "the server did not answer" }; }
    finally { running.current.delete(v.id); setBusy(new Set(running.current)); }
  }, [reload]);

  /** Strata's navigate_home_if_within: letting go of the volume you are looking at takes you home. */
  const leave = useCallback((v: Volume) => { if (v.mountPoint && (here === v.mountPoint || here.startsWith(v.mountPoint + "/"))) go(home); }, [here, home, go]);

  const act = useCallback(async (v: Volume, a: Exclude<VolumeAsk, "unlock">) => {
    const r = await work(v, a);
    if (!r) return;
    if (!r.ok) setFailed({ title: failedTitle(a, v), message: r.error ?? "" });
    else leave(v);
  }, [work, leave]);

  const open = useCallback(async (v: Volume) => {
    const c = clickOf(v);
    if (c === "unlock") { setAsk({ v, wrong: false }); return; }
    if (c === "open") { if (v.mountPoint) go(v.mountPoint); return; }
    const r = await work(v, "mount");
    if (!r) return;
    if (r.ok && r.mountPoint) go(r.mountPoint);
    else if (!r.ok) setFailed({ title: FAILED.mount, message: r.error ?? "" });
  }, [work, go]);

  const onVolumeAct = useCallback((v: Volume, a: VolumeAsk) => { if (a === "unlock") setAsk({ v, wrong: false }); else void act(v, a); }, [act]);

  const submit = useCallback(async (passphrase: string) => {
    const cur = ask; if (!cur) return;
    const r = await work(cur.v, "unlock", passphrase);
    if (!r) return;
    if (r.ok) { setAsk(null); if (r.mountPoint) go(r.mountPoint); }
    else setAsk({ v: cur.v, wrong: true });
  }, [ask, work, go]);

  /** Each reply from the server is the next step: a prompt to show, the mount to open, or why it failed. */
  const settle = useCallback((step: RemoteStep) => {
    const d = stepDialog(step);
    if (step.state === "done") { setConn(null); setNet(null); reload(); if (step.mountPoint) go(step.mountPoint); }
    else if (step.state === "password" || step.state === "question") setConn({ step, busy: false });
    else if (d?.kind === "error") { setConn(null); setNet(null); setFailed({ title: d.title, message: d.message }); }
  }, [reload, go]);
  const connect = useCallback((uri: string) => { void api.remoteConnect(uri).then(settle).catch(() => settle({ state: "error", error: "the server did not answer" })); }, [settle]);
  const answer = useCallback((a: { answers?: Record<string, string>; choice?: number }) => {
    if (!conn) return;
    const session = conn.step.session;
    setConn({ step: conn.step, busy: true });
    void api.remoteAnswer(session, a).then(settle).catch(() => settle({ state: "error", error: "the server did not answer" }));
  }, [conn, settle]);
  const cancel = useCallback(() => { if (conn) void api.remoteCancel(conn.step.session).catch(() => undefined); setConn(null); }, [conn]);
  const openNetwork = useCallback(() => { void api.network().then(setNet).catch(() => setNet({ ok: false, entries: [], error: "the server did not answer" })); }, []);

  const dialogs: ReactNode = (
    <>
      {ask && <PassphraseDialog name={ask.v.name} wrong={ask.wrong} busy={busy.has(ask.v.id)} onSubmit={(p) => void submit(p)} onCancel={() => setAsk(null)} />}
      {net && !conn && <NetworkDialog entries={net.entries} error={net.error} onPick={connect} onClose={() => setNet(null)} />}
      {conn && <ConnectDialog key={conn.step.session + conn.step.message} step={conn.step} busy={conn.busy} onAnswer={answer} onCancel={cancel} />}
      {failed && <ErrorDialog title={failed.title} message={failed.message} onClose={() => setFailed(null)} />}
    </>
  );
  /** An address typed in the path bar: a folder of a mount that exists opens, anything else connects. */
  const openAddress = useCallback((text: string) => { const r = resolveAddress(text, volumes); if (r.kind === "open") go(r.path); else connect(r.uri); }, [volumes, go, connect]);
  return { openAddress, openNetwork, volumes, busy, onVolume: (v: Volume) => void open(v), onVolumeAct, dialogs };
}
