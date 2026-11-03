import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import { followLink } from "../../lib/linkRouter.ts";
import { Select } from "../Select.tsx";
import { Button, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { Ph } from "../agents/phosphor.tsx";
import { Empty, SectionHead, SubLine } from "../agents/AgentsSections.tsx";
import type { BaseRed, ItemsAnswer, PolarisItem, SettingsAnswer } from "../../../../shared/polaris.ts";
import { baseBanners, baseOfItem, beaconOf, changeDoor, classCounts, draftSaveable, fixNotice, itemView, sendState, sortItems, syncResult, syncWarning, waitingOnYou, withoutNumber, type BannerView, type ItemAct, type ItemView } from "../../lib/polarisView.ts";

const CLEANUP_TEXT = "Close the session, remove the worktree and mark the card done.";
const MODE_WORDS: Record<string, string> = { dry: "dry run", live: "live", draft: "draft", off: "off" };

/** The buttons of an item: its one course, then the quieter clicks. Every one is a click of the person's; Polaris merges nothing. */
function CourseButton({ item, v, root, settings, bases, onChanged }: { item: PolarisItem; v: ItemView; root: string; settings: SettingsAnswer; bases?: BaseRed[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // Git only, once per row that can sync: whether this machine's copy has commits GitHub lacks.
  const [warn, setWarn] = useState<string | null>(null);
  useEffect(() => {
    if (!item.canSync) { setWarn(null); return; }
    let alive = true;
    void api.prLocalHead(root, item.head).then((r) => { if (alive) setWarn(syncWarning(r.ok && r.local ? r.local : null)); }).catch(() => {});
    return () => { alive = false; };
  }, [item.canSync, item.head, root]);
  const buttons = [...(v.act ? [v.act] : []), ...v.more];
  if (buttons.length === 0) return null;
  const reason = item.reason ? { reason: item.reason } : {};
  const run = async (what: ItemAct, e: React.MouseEvent) => {
    setNote("");
    if (what.kind === "open") { followLink(what.url, e); return; }
    if (what.kind === "beacon") { document.getElementById(`polaris-beacon-${item.number}`)?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
    if (what.kind === "sync") {
      setBusy(true);
      const r = await api.polarisAct(root, item.number, { type: "sync", headSha: item.headSha, baseSha: baseOfItem(bases, item.number)?.tipSha }).catch(() => null);
      setBusy(false);
      setNote(syncResult(r));
      if (r?.ok) onChanged();
      return;
    }
    setBusy(true);
    const call = () => {
      switch (what.kind) {
        case "undock": return api.polarisSettingsSave(changeDoor(settings, "project", "dock", withoutNumber(settings.doors.dock, item.number)), root);
        case "dock": return api.polarisAct(root, item.number, { type: "dock" });
        case "ignore": return api.polarisAct(root, item.number, { type: "ignore", ...reason });
        case "course": return api.polarisAct(root, item.number, { type: "propose", door: "course", text: what.text, ...reason });
        case "cleanup": return api.polarisAct(root, item.number, { type: "propose", door: "cleanup", text: CLEANUP_TEXT, ...reason });
        default: return null;
      }
    };
    const r = await (call() ?? Promise.resolve(null)).catch(() => null);
    setBusy(false);
    if (r && r.ok) onChanged(); else setNote(r && "error" in r && r.error ? r.error : "That did not go through");
  };
  return (
    <span className="pr-act">
      {buttons.map((b, i) => (
        <Button key={b.label} size="compact" tone={i === 0 && v.act ? undefined : "quiet"} pending={busy} disabled={busy || b.ghost} className={b.ghost ? "opacity-60" : undefined} onClick={(e) => void run(b.what, e)}>{b.label}</Button>
      ))}
      {warn && buttons.some((b) => b.what.kind === "sync") && <span className="mut" role="status">{warn}</span>}
      {note && <span className="mut" role="status">{note}</span>}
    </span>
  );
}

/** The base is red, or fixed with pull requests to sync. Shown only while it is true. */
function BaseBanner({ b, root, items, onChanged }: { b: BannerView; root: string; items: ItemsAnswer; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const base = items.bases?.find((x) => x.base === b.base);
  const syncAll = async () => {
    if (!b.syncAll || !base) return;
    setBusy(true);
    const out: string[] = [];
    // One at a time: each is its own update-branch on GitHub and each can say no (a conflict, a moved head).
    for (const n of b.syncAll.numbers) {
      const it = items.items.find((x) => x.number === n);
      if (!it) continue;
      const r = await api.polarisAct(root, n, { type: "sync", headSha: it.headSha, baseSha: base.tipSha }).catch(() => null);
      out.push(`#${n}: ${r?.ok ? (r.outcome === "skipped-in-dry-run" ? "dry run" : "syncing") : syncResult(r)}`);
    }
    setBusy(false);
    setNote(out.join(" · "));
    onChanged();
  };
  return (
    <div className="card" role="status" data-banner={b.tone} style={{ padding: "10px 14px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <span className={`agv-chip ${b.tone === "red" ? "line" : "ok"}`}><Ph name={b.tone === "red" ? "git-branch" : "check-circle"} size={13} />{b.tone === "red" ? "Inherited" : "Can sync"}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <b>{b.title}</b> <span className="mut">{b.detail}</span>
        {b.url && <> <a href={b.url} onClick={(e) => followLink(b.url!, e)}>Base run</a></>}
        {note && <span className="mut"> {note}</span>}
      </span>
      {b.syncAll && <Button size="compact" pending={busy} disabled={busy} onClick={() => void syncAll()}>{b.syncAll.label}</Button>}
    </div>
  );
}

/** The Pull requests section: every item in its class, with why and the one button of its course. */
export function PullRequestsSection({ root, settings, items, error, onChanged }: {
  root: string; settings: SettingsAnswer | null; items: ItemsAnswer | null; error: string | null; onChanged: () => void;
}) {
  if (!settings?.enabled) return null;
  const sorted = items ? sortItems(items.items) : [];
  const counts = classCounts(sorted).map((c) => `${c.n} ${c.cls.toLowerCase()}`).join(" · ");
  const d = settings.doors;
  const bell = d.cleared.mode === "bell";
  const banners = baseBanners(items?.bases);
  const fixed = fixNotice(items?.bases);
  const canSync = (items?.bases ?? []).reduce((n, b) => n + b.canSync.length, 0);
  return (
    <div>
      <SectionHead title="Pull requests" count={sorted.length} hint={counts || undefined}>
        {d.relaunch.mode !== "off" && <span className="agv-chip line"><Ph name="arrows-clockwise" size={13} />Relaunch: {MODE_WORDS[d.relaunch.mode]}</span>}
        {canSync > 0 && <span className="agv-chip ok"><Ph name="arrows-clockwise" size={13} />{canSync} can sync</span>}
        {d.beacon.mode !== "off" && <span className="agv-chip line"><Ph name="chat-circle-text" size={13} />Beacon: {MODE_WORDS[d.beacon.mode]}</span>}
      </SectionHead>
      <SubLine src="from Polaris" icon="compass" notify={bell ? "now" : "quiet"} notifyText={bell ? "Rings when one is cleared to land" : undefined} />
      {error && <div className="err-line" role="alert">{error}</div>}
      {fixed && <FixToast key={fixed.key} text={fixed.text} />}
      {items && banners.map((b) => <BaseBanner key={b.base} b={b} root={root} items={items} onChanged={onChanged} />)}
      {items?.uncharted && (
        <Empty icon="warning-circle" title="Polaris cannot read the pull requests">{items.uncharted}</Empty>
      )}
      {items && !items.uncharted && sorted.length === 0 && (
        <Empty icon="check-circle" title="No open pull requests">When one opens in this repository, it is filed here with a reason.</Empty>
      )}
      {sorted.length > 0 && (
        <div className="card prs">
          {sorted.map((i) => {
            const v = itemView(i, d);
            return (
              <div className="pr" key={i.number} data-class={i.cls}>
                <span className={`agv-chip ${v.tone}`}>{v.cls}</span>
                {v.inherited && <span className="agv-chip line" title="The base branch is red on this check too">inherited</span>}
                <span className="mut">#{v.number}</span>
                <div className="pr-t">
                  <b title={v.title}>{v.title}</b>
                  <div className="mut">{v.sentence}{v.note ? ` ${v.note}` : ""}{v.waitsOn ? ` Waits on ${v.waitsOn}.` : ""}</div>
                </div>
                <CourseButton item={i} v={v} root={root} settings={settings} bases={items?.bases} onChanged={onChanged} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A short notice that a base went green, once per fixing commit; the person closes it. */
function FixToast({ text }: { text: string }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div className="card" role="status" style={{ padding: "8px 14px", display: "flex", gap: 10, alignItems: "center" }}>
      <Ph name="check-circle" size={16} /><span style={{ flex: 1 }}>{text}</span>
      <Button size="compact" tone="quiet" onClick={() => setOpen(false)}>Dismiss</Button>
    </div>
  );
}

/** A beacon the orchestrator drafted: the text as written, the person's Edit and Discard, and the person's Send. */
function BeaconDraft({ item, root, match, panes, onChanged }: { item: PolarisItem; root: string; match: string; panes: { id: string; label: string }[]; onChanged: () => void }) {
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [text, setText] = useState<string | null>(null);
  const s = sendState(match, picked);
  const b = beaconOf(item);
  const reason = b.reason ? { reason: b.reason } : {};
  const finish = (r: { ok: boolean; error?: string } | null, then?: () => void) => {
    setBusy(false);
    if (r?.ok) { then?.(); onChanged(); } else setErr(r?.error ?? "That did not go through");
  };
  const send = async () => { setBusy(true); setErr(""); finish(await api.polarisBeaconSend(root, item.number, { ...reason, ...(picked ? { paneId: picked } : {}) }).catch(() => null)); };
  const save = async () => { setBusy(true); setErr(""); finish(await api.polarisBeaconEdit(root, item.number, { ...reason, text: text ?? "" }).catch(() => null), () => setText(null)); };
  const discard = async () => { setBusy(true); setErr(""); finish(await api.polarisBeaconDiscard(root, item.number, reason).catch(() => null)); };
  return (
    <>
      {text === null
        ? <div className="what" style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{b.draft}</div>
        : <textarea value={text} rows={4} aria-label={`Beacon for #${item.number}`} disabled={busy} onChange={(e) => setText(e.target.value)} className={INPUT} style={{ ...INPUT_STYLE, width: "100%", resize: "vertical" }} />}
      <div className="acts">
        <Select value={picked} title="The session that gets the beacon" className="agx-select rounded-lg px-2 py-1.5 text-[12px] outline-none w-[220px] justify-between"
          options={[{ value: "", label: match === "use" ? "The session on this branch" : "Pick a session" }, ...panes.map((p) => ({ value: p.id, label: p.label }))]} onChange={setPicked} />
        <Button tone="primary" pending={busy} disabled={busy || !s.can || text !== null} onClick={() => void send()}>Send</Button>
        {text === null ? (
          <>
            <Button disabled={busy} onClick={() => setText(b.draft ?? "")}>Edit</Button>
            <Button tone="quiet" disabled={busy} onClick={() => void discard()}>Discard</Button>
          </>
        ) : (
          <>
            <Button disabled={busy || !draftSaveable(b.draft, text)} onClick={() => void save()}>Save the text</Button>
            <Button tone="quiet" disabled={busy} onClick={() => setText(null)}>Cancel</Button>
          </>
        )}
        <span className="mut">{text === null ? s.hint : "Nothing is sent until you press Send."}</span>
      </div>
      {err && <div className="err-line" role="alert">{err}</div>}
    </>
  );
}

/** Needs you and Cleared to land items, as rows of Waiting on you. */
export function PolarisWaiting({ root, settings, items, panes, onChanged }: {
  root: string; settings: SettingsAnswer | null; items: ItemsAnswer | null; panes: { id: string; label: string }[]; onChanged: () => void;
}) {
  if (!settings?.enabled || !items) return null;
  const rows = waitingOnYou(items.items, settings.doors);
  return (
    <>
      {rows.map((i) => {
        const v = itemView(i, settings.doors);
        return (
          <div className="card ask q" id={`polaris-beacon-${i.number}`} key={`polaris-${i.number}`}><div className="rail" /><div className="in">
            <div className="t"><span className="badge"><Ph name="compass" size={18} /></span><b title={v.title}>#{v.number} {v.title}</b><span className={`agv-chip ${v.tone}`}>{v.cls}</span></div>
            <div className="what" style={{ fontSize: 14 }}>{v.sentence}</div>
            {beaconOf(i).draft ? <BeaconDraft item={i} root={root} match={String(settings.doors.match.mode)} panes={panes} onChanged={onChanged} />
              : <div className="acts"><CourseButton item={i} v={v} root={root} settings={settings} bases={items.bases} onChanged={onChanged} /></div>}
          </div></div>
        );
      })}
    </>
  );
}
