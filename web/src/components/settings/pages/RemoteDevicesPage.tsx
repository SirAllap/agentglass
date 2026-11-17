import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section, DangerZone } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { DangerAction, pushSaveToast } from "../save/index.ts";
import { Switch } from "../../SettingRow.tsx";
import { api } from "../../../lib/api.ts";
import { remoteAccessEnabled, setRemoteAccess, revokeRemoteAccess } from "../../../lib/desktop.ts";
import { newlySecure, pickIndex, readPick, writePick, type PickedAddress } from "../../../lib/remoteLink.ts";
import { usePoll } from "../../../lib/usePoll.ts";
import type { RemoteStatus } from "../../../../../shared/types.ts";
import { PairPanel } from "../../PairPanel.tsx";
import { Recipe, Seen } from "../../RemoteAccessPane.tsx";
import { linkView, peerLabel, devicesIntro, routeRows, tailnetNote, accessSub, devicesWait, CAPABILITIES, SCOPE_CHIP, type RouteRow, type TailnetNote } from "../../../lib/remoteView.ts";
import { DesktopIcon, CheckMark, DashMark, LockMark, WarnMark } from "../../deviceIcons.tsx";
import { PhoneIcon } from "../../settingsNavIcons.tsx";
import { StatusBadge } from "../../SettingsKit.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { LINE } from "../../workspace/Chrome.tsx";
import { Button } from "../../workspace/Chrome.tsx";
import type { ReactNode } from "react";

const PURPOSE = "Reach this machine from your phone, and manage the phones you paired.";

/** Remote & devices: the one switch, who may reach this machine, the paired phones and the token. */
export function RemoteDevicesPage({ open }: { open: boolean }) {
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [paired, setPaired] = useState<number | null>(null);
  const [pairedNames, setPairedNames] = useState<string[]>([]);
  const onPaired = useCallback((n: number, names: string[]) => { setPaired(n); setPairedNames(names); }, []);
  const [chosen, setChosen] = useState<PickedAddress | null>(() => readPick());
  const lastAddrs = useRef<RemoteStatus["addresses"] | null>(null);
  const wantFresh = useRef(false);
  const apply = useCallback((s: RemoteStatus | null) => {
    setSt(s);
    if (!s) return;
    wantFresh.current = !!s.tailnet?.installed && !s.addresses.some((a) => a.secure);
    const fresh = newlySecure(lastAddrs.current, s.addresses);
    lastAddrs.current = s.addresses;
    if (fresh) { setChosen(fresh); writePick(fresh); }
  }, []);
  const load = useCallback(() => {
    api.remoteStatus(wantFresh.current).then((s) => { setFailed(false); apply(s); }).catch(() => { setSt(null); setFailed(true); });
  }, [apply]);
  useEffect(() => { if (!open) return; load(); void remoteAccessEnabled().then(setEnabled); }, [open, load]);
  usePoll(open, load, 3000);

  const toggle = async () => {
    setBusy(true);
    const before = enabled;
    const next = await setRemoteAccess(!enabled);
    setBusy(false);
    if (next !== null) {
      setEnabled(next);
      pushSaveToast("Saved", () => { void setRemoteAccess(!!before).then((v) => { if (v !== null) setEnabled(v); load(); }); });
    }
    load();
  };
  const rotate = async () => {
    setBusy(true);
    const ok = await revokeRemoteAccess();
    setBusy(false);
    if (ok) { setNote(null); load(); return; }
    setNote(ok === false
      ? "The token is set in the environment this app started from. Unset it there and restart."
      : "Nothing changed. This shell cannot rotate the token, or the server did not confirm.");
  };

  const pairAddrs = st?.addresses ?? [];
  const pick = Math.min(pickIndex(pairAddrs, chosen), Math.max(0, pairAddrs.length - 1));
  const url = st?.urls[pick] ?? "";
  const live = !!st && st.exposed && st.trustLan && st.urls.length > 0;
  const seen = st ? st.devices.filter((d) => !d.self) : [];
  const firstRun = live && paired === 0 && seen.length === 0;
  const unreachable = devicesWait({ failed, st }) === "unreachable";
  const down = (
    <div role="alert" className="flex items-center justify-between gap-3 px-3 py-2.5 text-[12px]" style={{ color: "var(--error-ink)" }}>
      <span>Can't reach the network state right now.</span><Button onClick={load}>Retry</Button>
    </div>
  );

  const routes = routeRows(pairAddrs, pick);
  const tailnet = !!(chosen?.tailnet || pairAddrs[pick]?.tailnet);
  const tnote = st ? tailnetNote(st.tailnet, pairAddrs.some((a) => a.tailnet)) : null;
  const choose = (address: string) => {
    const a = pairAddrs.find((x) => x.address === address);
    if (a) { setChosen(a); writePick(a); }
  };

  const access = (
    <Section id="access" title="Remote access" intro={unreachable ? undefined : "Only a paired phone reaches the dashboard and the actions you allow."}>
      {unreachable && down}
      {!st && !failed && <div data-skeleton className="px-3 py-2.5 text-[12px]" style={{ color: "var(--text2)" }}>Reading the network state…</div>}
      {st && enabled === null && <Recipe port={st.port} />}
      {st && enabled !== null && (() => {
        const view = linkView({ enabled, paired, live: st.clients.liveCount });
        return (
          <>
            {/* The switch is a row, so search reaches it; its control column keeps it at the right whatever the line says. */}
            <SettingRow kind="control" label="Allow remote access" help={accessSub({ enabled, busy, tailnet })}
              control={<button role="switch" aria-checked={!!enabled} aria-label="Allow remote access" disabled={busy} onClick={() => void toggle()} className="agx-btn"><Switch on={!!enabled} busy={busy} /></button>} />
            <div className="px-3.5 pb-3.5">
              <div className="flex items-center gap-2 text-[15px] font-semibold" style={{ color: "var(--text)" }}>
                <span aria-hidden className="shrink-0 rounded-full" style={{ width: 9, height: 9, background: view.tone === "ok" ? "var(--success)" : view.tone === "warn" ? "var(--warning)" : "var(--text4)" }} />
                {view.label}
              </div>
              <LinkStrip view={view} peer={peerLabel(pairedNames)} host={st.devices.find((d) => d.self)?.label ?? "This machine"} />
            </div>
          </>
        );
      })()}
      {st && routes.length > 0 && <Routes rows={routes} onPick={choose} />}
      {st && tnote && <Note note={tnote} />}
    </Section>
  );
  const devices = st ? (
    <PairPanel baseUrl={url} active={open} off={!live} variant={firstRun ? "hero" : "row"} onPaired={onPaired}
      canTurnOnHttps={!!st.tailnet?.installed && !st.addresses.some((a) => a.secure)} onStatus={apply}
      frame={(action, body) => <Section id="devices" title="Paired devices" intro={devicesIntro(paired ?? 0)} action={action}>{body}</Section>} />
  ) : (
    <Section id="devices" title="Paired devices" intro={unreachable ? undefined : devicesIntro(paired ?? 0)}>
      {unreachable ? down : <div data-skeleton className="px-3 py-2.5 text-[12px]" style={{ color: "var(--text2)" }}>Reading the paired devices…</div>}
    </Section>
  );
  const can = (
    <Section id="can" title="What a phone can do" intro={`Three levels, picked when you let a device in. ${SCOPE_CHIP.answer} is the default.`}>
      <Capabilities />
    </Section>
  );
  const reached = st && seen.length > 0 ? (
    <Section id="seen" title="Who has reached this machine">
      <Seen st={st} onChanged={load} />
    </Section>
  ) : null;
  const danger = (
    <DangerZone>
      <SettingRow kind="control" label="Machine token"
        help="Forgets every paired device, so phones you keep must pair again."
        control={<DangerAction label="Rotate token" onConfirm={() => rotate()} />} />
      {note && <div role="alert" className="px-3 pb-2.5 text-[12px]" style={{ color: "var(--error-ink)" }}>{note}</div>}
    </DangerZone>
  );
  const sections = [
    { id: "access", title: "Remote access", kind: "normal" as const, body: access },
    { id: "devices", title: "Paired devices", kind: "normal" as const, body: devices },
    { id: "can", title: "What a phone can do", kind: "normal" as const, body: can },
    ...(reached ? [{ id: "seen", title: "Who has reached this machine", kind: "normal" as const, body: reached }] : []),
    ...(st?.tokenRequired && enabled !== null ? [{ id: "danger", title: "Danger zone", kind: "danger" as const, body: danger }] : []),
  ];
  return <SettingsPage title="Remote & devices" purpose={PURPOSE} sections={sections} />;
}

/** This machine, the line, and the phones: the state in one look. Tokens only. */
function LinkStrip({ view, peer, host }: { view: ReturnType<typeof linkView>; peer: ReturnType<typeof peerLabel>; host: string }) {
  const tone = view.tone === "ok" ? "var(--success-ink)" : view.tone === "warn" ? "var(--warning-ink)" : "var(--text2)";
  const node = (icon: ReactNode, name: string, sub: string, accent: boolean) => (
    <span className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden className="grid shrink-0 place-items-center rounded-lg" style={{ width: 40, height: 40, background: "var(--surface-inset)", color: accent ? "var(--primary)" : "var(--text2)" }}>{icon}</span>
      <span className="min-w-0">
        <span className="block break-words text-[13px] font-medium" style={{ color: "var(--text)" }}>{name}</span>
        <span className="block text-[11.5px]" style={{ color: "var(--text3)" }}>{sub}</span>
      </span>
    </span>
  );
  return (
    <div role="status" aria-label={view.label} className="mt-3 flex items-center gap-3 rounded-lg px-3 py-2.5" style={{ background: "var(--surface-inset)" }}>
      {node(<DesktopIcon size={ICON.rail} />, host, "This machine", false)}
      <span className="flex min-w-[80px] flex-1 flex-col items-center gap-1">
        <span aria-hidden className="w-full" style={{ borderTop: view.line ? `2px ${view.tone === "ok" ? "solid" : "dashed"} ${view.tone === "ok" ? "color-mix(in srgb, var(--success) 55%, transparent)" : "var(--surface-line)"}` : "2px solid transparent" }} />
        <span className="text-center text-[11.5px]" style={{ color: tone }}>{view.label}</span>
      </span>
      {node(<PhoneIcon size={ICON.rail} />, peer.name, peer.sub, true)}
    </div>
  );
}

/** Every address a phone can open, picked by radio. HTTPS lets the app and a browser pair; plain HTTP only the app. */
function Routes({ rows, onPick }: { rows: RouteRow[]; onPick: (address: string) => void }) {
  const head = "px-2 py-1.5 text-[11px] font-medium";
  const many = rows.length > 1;
  return (
    <div role="radiogroup" aria-label="Route" className="grid items-center" style={{ gridTemplateColumns: "40px minmax(0, 1fr) minmax(0, 1.4fr) auto", borderTop: LINE }}>
      <span className={head} />
      <span className={head} style={{ color: "var(--text3)" }}>Route</span>
      <span className={head} style={{ color: "var(--text3)" }}>Address a phone opens</span>
      <span className={`${head} pr-3.5`} style={{ color: "var(--text3)" }}>Pairing</span>
      {rows.map((r) => {
        const cell = { borderTop: LINE, background: r.on && many ? "color-mix(in srgb, var(--primary) 6%, transparent)" : undefined } as const;
        const id = `route-${r.address}`;
        return (
          <label key={r.address} htmlFor={id} className="contents cursor-pointer">
            <span className="flex h-full items-center justify-center py-2.5" style={cell}>
              <input id={id} type="radio" name="remote-route" checked={r.on} onChange={() => onPick(r.address)} style={{ accentColor: "var(--primary)" }} />
            </span>
            <span className="flex h-full min-w-0 flex-col justify-center px-2 py-2.5" style={cell}>
              <span className="block text-[13px] font-medium" style={{ color: "var(--text)" }}>{r.label}</span>
              <span className="t-mono block text-[11px]" style={{ color: "var(--text3)" }}>{r.iface}</span>
            </span>
            <span className="flex h-full min-w-0 items-center px-2 py-2.5" style={cell}>
              <span className="t-mono break-all rounded-md px-1.5 py-0.5 text-[12px]" style={{ background: "var(--surface-inset)", color: "var(--text)" }}>{r.address}</span>
            </span>
            <span className="flex h-full items-center py-2.5 pl-2 pr-3.5" style={cell}>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium" style={r.secure
                ? { background: "color-mix(in srgb, var(--success) 14%, transparent)", color: "var(--success-ink)" }
                : { background: "var(--surface-inset)", color: "var(--text2)" }}>
                <LockMark open={!r.secure} />{r.pairing}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** The line under the routes: no Tailscale here, or Tailscale not answering. */
function Note({ note }: { note: TailnetNote }) {
  const ink = note.tone === "err" ? "var(--error-ink)" : note.tone === "warn" ? "var(--warning-ink)" : "var(--text2)";
  const wash = note.tone === "err" ? "color-mix(in srgb, var(--error) 8%, transparent)" : note.tone === "warn" ? "color-mix(in srgb, var(--warning) 9%, transparent)" : undefined;
  return (
    <div role={note.tone === "off" ? undefined : "alert"} className="flex items-start gap-2 px-3.5 py-2.5 text-[12px]" style={{ borderTop: LINE, background: wash, color: "var(--text2)" }}>
      <span aria-hidden className="mt-0.5 shrink-0" style={{ color: ink }}>{note.tone === "off" ? <LockMark open /> : <WarnMark />}</span>
      <span><b className="font-semibold" style={{ color: ink }}>{note.title}</b> {note.body}</span>
    </div>
  );
}

/** What each level allows, in one table. The default level's column is tinted. */
function Capabilities() {
  const tint = "color-mix(in srgb, var(--primary) 7%, transparent)";
  const col = (on: boolean, i: number) => (
    <span role="cell" key={i} className="flex h-full items-center justify-center py-2" style={{ borderTop: LINE, background: i === 1 ? tint : undefined, color: on ? "var(--success-ink)" : "var(--text4)" }}>
      {on ? <><CheckMark /><span className="sr-only">Yes</span></> : <><DashMark /><span className="sr-only">No</span></>}
    </span>
  );
  const head = "px-2 py-2 text-center text-[11.5px] font-semibold";
  return (
    <div role="table" aria-label="What a phone can do" className="grid items-stretch" style={{ gridTemplateColumns: "minmax(0, 1fr) repeat(3, 108px)" }}>
      <div role="row" className="contents">
        <span role="columnheader" className="px-3.5 py-2 text-[11.5px] font-medium" style={{ color: "var(--text3)" }}>A paired device with</span>
        <span role="columnheader" className={head} style={{ color: "var(--text)" }}>{SCOPE_CHIP.read}</span>
        <span role="columnheader" className={`${head} whitespace-nowrap`} style={{ color: "var(--text)", background: tint }}>{SCOPE_CHIP.answer}</span>
        <span role="columnheader" className={head} style={{ color: "var(--text)" }}>{SCOPE_CHIP.full}</span>
      </div>
      {CAPABILITIES.map((g) => (
        <div key={g.group} role="rowgroup" className="contents">
          <div role="row" className="contents">
            <span role="cell" className="col-span-4 px-3.5 pb-1 pt-2.5 text-[11px] font-semibold" style={{ borderTop: LINE, color: "var(--text3)" }}>{g.group}</span>
          </div>
          {g.rows.map((r) => (
            <div key={r.what} role="row" className="contents">
              <span role="cell" className="px-3.5 py-2 text-[12.5px]" style={{ borderTop: LINE, color: "var(--text)" }}>{r.what}</span>
              {[r.read, r.answer, r.full].map(col)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
