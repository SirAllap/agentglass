// Notifications on the new Settings shell (v2): Pop-ups (Desktop DND, News
// pop-ups and the "Where it shows" table), Apps (Pop up / Bell only / Mute per
// app), More, Asked for, Sound. Every switch saves at once with "Saved · Undo".
// Session state the modal owns (chime, voices, mirror mode) comes in as `c`.
import { useEffect, useState, useSyncExternalStore } from "react";
import { SettingsPage, type PageSection } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { instantSave, pushSaveToast, SaveToastHost } from "../save/index.ts";
import { Button, LINE, Segmented } from "../../workspace/Chrome.tsx";
import { VoicePicker } from "../../SettingsModal.tsx";
import { AskedAlertLog } from "../../AskedAlertLog.tsx";
import { Switch } from "../../SettingRow.tsx";
import { api } from "../../../lib/api.ts";
import { setPageFact } from "../../../lib/pageFacts.ts";
import { ALARM_VOICES, NOTIFY_VOICES } from "../../../lib/sounds.ts";
import { sendTestNote, setNotifyVoice, setSysNotifyOn, setSysNotifyMode, type SysNotifyMode } from "../../../lib/sysNotify.ts";
import { setAlarmVoice } from "../../../lib/alarm.ts";
import { OUR_RULE, TEST_KINDS, TEST_KIND_LABEL, appRows, appRules, chooseApp, mutedSources, ruleFor, sourceLabel, subscribeAppRules, subscribeMuted, type AppChoice, type TestKind } from "../../../lib/notePolicy.ts";
import { POP_LEVELS, levelFrom, notifyStates, storedOf, type NotifyStates, type PopLevel } from "../../../lib/notifyStates.ts";
import { setting } from "../../../lib/settingsRegistry.ts";
import { listGates, subscribeGates } from "../../../lib/gateStore.ts";
import { breakThrough, desktopDnd, refreshDesktopDnd, setBreakThrough, setDesktopDnd, subscribeDesktopDnd } from "../../../lib/desktopDnd.ts";
import { notifyHistory, notifyQuiet, setNotifyQuiet, subscribeNotifyHistory } from "../../../lib/sysNotify.ts";
import { getNotifyPrefs, subscribeNotifyPrefs, saveNotifyPrefs } from "../../../lib/notifyPrefsStore.ts";
import { NOTIFY_KINDS, NOTIFY_CHANNELS, NOTIFY_KIND_LABEL, NOTIFY_CHANNEL_LABEL, type NotifyKind, type NotifyChannel } from "../../../../../shared/notifyPrefs.ts";
import { NOTIFICATIONS_PURPOSE, NOTIFICATIONS_SECTIONS } from "./notificationsModel.ts";
import type { PageCtx } from "./ctx.ts";
import { registerRead, useSettingsData } from "../shell/pageLoad.tsx";

const help = (section: string, label: string) =>
  NOTIFICATIONS_SECTIONS.find((s) => s.id === section)!.rows.find((r) => r.label === label)!.help;

function SwitchControl({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className="agx-btn" onClick={() => onChange(!on)}>
      <Switch on={on} />
    </button>
  );
}

/* The phone is a channel the server keeps; a read that is not a boolean leaves the row disabled. */
const PHONE_READ = "notifications/phone";
registerRead("notifications", PHONE_READ, () => api.phoneAlerts().then((r) => (r.ok && typeof r.value === "boolean" ? r.value : null)));

/** A list of rows shown only when asked for: kept out of the way, never hidden. */
function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-[12px]" aria-expanded={open}
        style={{ borderTop: LINE, color: "var(--text2)" }} onClick={() => setOpen((v) => !v)}>
        <span aria-hidden style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none" }}>›</span>{label}
      </button>
      {open && children}
    </>
  );
}

/** Settings ▸ Notifications ▸ Pop-ups: "Which switch wins", top wins, each with its state now (lib/notifyStates.ts). */
function WhichSwitchWins({ wins }: { wins: NotifyStates["wins"] }) {
  return (
    <div data-row="which-switch-wins" className="px-3 py-2.5" style={{ borderTop: LINE }}>
      <div className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>Which switch wins <span className="text-[12px] font-normal" style={{ color: "var(--text3)" }}>· top wins</span></div>
      <ol className="mt-1.5">
        {wins.map((w, i) => (
          <li key={w.id} data-wins={w.id} className="grid items-start gap-2 py-1.5" style={{ gridTemplateColumns: "18px 1fr auto", borderTop: i ? LINE : undefined }}>
            <span className="text-[12px] tabular-nums" style={{ color: "var(--text4)" }}>{i + 1}</span>
            <span className="min-w-0">
              <span className="block text-[12px]" style={{ color: "var(--text)" }}>{w.label}</span>
              <span className="block text-[11px]" style={{ color: "var(--text3)" }}>{w.sub}</span>
            </span>
            <span className="text-[11px] px-1.5 rounded whitespace-nowrap" style={w.active
              ? { background: "var(--primary)", color: "var(--on-primary)", fontWeight: 600 }
              : { color: "var(--text3)", border: LINE }}>{w.pill}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Settings ▸ Notifications ▸ Pop-ups: where each kind shows now, from the same answer as the list above. */
function WhereItShows({ where }: { where: NotifyStates["where"] }) {
  return (
    <div className="px-3 py-2.5" style={{ borderTop: LINE }}>
      <table className="w-full text-left" style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr className="text-[11px]" style={{ color: "var(--text3)" }}>
            <th className="px-3 py-1.5 font-semibold">Where it shows now</th>
            <th className="px-3 py-1.5 font-semibold">Result</th>
          </tr>
        </thead>
        <tbody>
          {where.map((r) => (
            <tr key={r.id} style={{ borderTop: LINE }}>
              <th className="px-3 py-2 text-[12px] font-normal align-top" style={{ color: "var(--text2)" }}>{r.what}</th>
              <td className="px-3 py-2 align-top">
                <div className="text-[12px]" style={{ color: "var(--text)" }}>{r.main}</div>
                {r.sub && <div className="text-[11px]" style={{ color: "var(--text3)" }}>{r.sub}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How long the test waits, so the person can go to the view (or hide the window) they want to test. */
const TEST_DELAY_S = 5;

/** Settings ▸ Notifications ▸ Pop-ups ▸ Send a test notification: pick kinds, a 5-second countdown with Cancel, then one test note of each. */
function TestNotification() {
  const [kinds, setKinds] = useState<ReadonlySet<TestKind>>(() => new Set(TEST_KINDS));
  const [left, setLeft] = useState<number | null>(null);
  const [sent, setSent] = useState<string>("");
  useEffect(() => {
    if (left === null) return;
    if (left === 0) {
      const said = [...kinds].map((k) => `${TEST_KIND_LABEL[k]}: ${sendTestNote(k)}`);
      setSent(said.join(" · "));
      setLeft(null);
      return;
    }
    const id = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(id);
  }, [left, kinds]);
  const toggle = (k: TestKind) => setKinds((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5 flex-wrap justify-end" role="group" aria-label="Kinds to send">
        {TEST_KINDS.map((k) => (
          <Button key={k} size="compact" on={kinds.has(k)} aria-pressed={kinds.has(k)} disabled={left !== null} onClick={() => toggle(k)}>{TEST_KIND_LABEL[k]}</Button>
        ))}
        {left === null
          ? <Button size="compact" disabled={kinds.size === 0} onClick={() => { setSent(""); setLeft(TEST_DELAY_S); }}>Send</Button>
          : <Button size="compact" onClick={() => setLeft(null)}>Sending in {left}… Cancel</Button>}
      </div>
      {sent && <div className="text-[11px] text-right" role="status" style={{ color: "var(--text3)" }}>{sent}</div>}
    </div>
  );
}

export function NotificationsPage({ c }: { c: PageCtx }) {
  const { alarmVoice, notifyCap, notifyVoice, onSound, quiet, setAlarmVoiceState, setNotifyVoiceState, sound, sysNotify } = c;
  useEffect(() => { setPageFact("news", quiet ? "off" : "on"); }, [quiet]);
  const prefs = useSyncExternalStore(subscribeNotifyPrefs, getNotifyPrefs, getNotifyPrefs);
  const muted = useSyncExternalStore(subscribeMuted, mutedSources, mutedSources);
  const rules = useSyncExternalStore(subscribeAppRules, appRules, appRules);
  const dnd = useSyncExternalStore(subscribeDesktopDnd, desktopDnd, desktopDnd);
  const breaks = useSyncExternalStore(subscribeDesktopDnd, breakThrough, breakThrough);
  const hist = useSyncExternalStore(subscribeNotifyHistory, notifyHistory, notifyHistory);
  const waiting = useSyncExternalStore(subscribeGates, listGates, listGates).length;
  useEffect(() => { void refreshDesktopDnd(); }, []);
  type Prefs = typeof prefs;
  const writePrefs = (v: Prefs) => { saveNotifyPrefs(v).catch(() => pushSaveToast("Could not save", () => {})); };
  const savePrefs = (next: Prefs) => instantSave(prefs, next, (v) => writePrefs(v as Prefs));
  const setKind = (k: NotifyKind, on: boolean) => savePrefs({ ...prefs, kinds: { ...prefs.kinds, [k]: on } });
  const setChannel = (ch: NotifyChannel, on: boolean) => savePrefs({ ...prefs, channels: { ...prefs.channels, [ch]: on } });

  // The phone is a channel the server keeps (`phone.alerts`), read when the page opens.
  // Through the Settings cache, so a second visit (or a hover on the nav row) has it before the page paints.
  const { data: phoneRead, set: setPhoneRead } = useSettingsData<boolean | null>(PHONE_READ);
  const phone = phoneRead ?? null;
  const setPhone = (on: boolean) => setPhoneRead(on);
  const writePhone = (on: boolean) => {
    setPhone(on);
    api.settingsDoorSet("phone.alerts", on)
      .then((r) => { if (!r.ok) throw new Error(r.error); })
      .catch(() => { setPhone(!on); pushSaveToast("Could not save", () => {}); });
  };

  const mirrorLocked = notifyCap ? !notifyCap.supported && !notifyCap.transient : true;
  const mirrorWhy = notifyCap && !notifyCap.supported ? (notifyCap.transient ? `Checking: ${notifyCap.reason}` : `Unavailable: ${notifyCap.reason}`) : null;
  const COLLECT = "Collect other apps' notifications";
  const mirrorRow = (
    <SwitchControl on={sysNotify !== "off"} label={COLLECT} disabled={mirrorLocked}
      onChange={(on) => instantSave(sysNotify !== "off", on, (b) => setSysNotifyOn(b))} />
  );
  const news = !notifyQuiet();
  const level = levelFrom(prefs.none, quiet, ruleFor(OUR_RULE, rules) === "popup");
  const states = notifyStates({ dnd: dnd.on, silenced: prefs.none, level, waiting, breakThrough: breaks });
  const pickLevel = (l: PopLevel) => instantSave(storedOf(level), storedOf(l), (v) => setting("notifications.volume").set(v));
  const apps = appRows(hist.map((n) => n.source ?? ""), rules, muted);
  const dndHelp = dnd.supported ? help("popups", "Desktop DND")
    : "This desktop cannot report its DND, so this is agentglass's own switch.";

  const sections: PageSection[] = [
    { id: "popups", title: "Pop-ups", kind: "normal", body: (
      <Section id="popups" title="Pop-ups">
        <SettingRow agentNever="changes the desktop's own Do Not Disturb, which decides what reaches the owner outside this app" kind="control" label="Desktop DND" help={dndHelp}
          control={<SwitchControl on={dnd.on} label="Desktop DND" onChange={(v) => instantSave(dnd.on, v, (x) => void setDesktopDnd(x as boolean))} />} />
        <SettingRow kind="control" settingId="notifications.volume" label="What pops up" help={help("popups", "What pops up")}
          tag={<span data-renamed className="inline-block mt-1 text-[10px] px-1 rounded" style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 50%, transparent)" }}>renamed</span>}
          control={<Segmented<PopLevel> track label="What pops up" value={prefs.none ? "nothing" : level}
            onChange={pickLevel} options={POP_LEVELS.map((l) => ({ id: l.id, label: l.label }))} />} />
        <SettingRow kind="control" settingId="notifications.quiet" label="News pop-ups" help={prefs.none ? "Held off by Silence all." : help("popups", "News pop-ups")}
          control={<SwitchControl on={news} label="News pop-ups" disabled={prefs.none} onChange={(v) => instantSave(news, v, (x) => setNotifyQuiet(!(x as boolean)))} />} />
        <SettingRow kind="control" agentExempt label="Send a test notification" help={help("popups", "Send a test notification")}
          control={<TestNotification />} />
        <WhichSwitchWins wins={states.wins} />
        <WhereItShows where={states.where} />
      </Section>
    ) },
    { id: "apps", title: "Apps", kind: "normal", body: (
      <Section id="apps" title="Apps" intro="Pop up, Bell only (kept and counted, no pop-up), or Mute (not kept at all).">
        {apps.map((a) => {
          const name = a.source === "agentglass" ? "agentglass news" : sourceLabel(a.source);
          const opts: { id: AppChoice; label: string }[] = [{ id: "popup", label: "Pop up" }, { id: "bell", label: "Bell only" }];
          if (a.source !== "agentglass") opts.push({ id: "mute", label: "Mute" });
          return (
            <SettingRow key={a.source} kind="control" agentExempt label={name}
              help={a.byDefault ? "Bell only by default: low value." : a.source === "agentglass" ? "PRs, checks, branches and finished agents; a waiting agent always pops up." : ""}
              control={<Segmented<AppChoice> track label={name} value={a.choice}
                onChange={(v) => instantSave(a.choice, v, (x) => chooseApp(a.source, x as AppChoice))} options={opts} />} />
          );
        })}
      </Section>
    ) },
    { id: "more", title: "More", kind: "normal", body: (
      <Section id="more" title="More">
        {mirrorWhy
          ? <SettingRow agentNever="reads other applications' notifications into this app: what they say is theirs" kind="locked" label="Collect other apps' notifications" help={help("more", COLLECT)} reason={mirrorWhy} control={mirrorRow} />
          : <SettingRow agentNever="reads other applications' notifications into this app: what they say is theirs" kind="control" label="Collect other apps' notifications" help={help("more", COLLECT)} control={mirrorRow} />}
        {sysNotify !== "off" && (
          <SettingRow agentNever="reads other applications' notifications into this app: what they say is theirs" kind="control" label="How much of the message" help={help("more", "How much of the message")}
            control={<Segmented<SysNotifyMode> track label="How much of the message" value={sysNotify}
              onChange={(m) => instantSave(sysNotify, m, (v) => setSysNotifyMode(v as SysNotifyMode))}
              options={[{ id: "titles", label: "Who" }, { id: "full", label: "Full" }]} />} />
        )}
        <SettingRow kind="control" agentExempt label="Silence all" help={help("more", "Silence all")}
          control={<SwitchControl on={prefs.none} label="Silence all" onChange={(n) => savePrefs({ ...prefs, none: n })} />} />
        <SettingRow agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence" kind="control" label="Agents waiting on you break through DND" help={help("more", "Agents waiting on you break through DND")}
          control={<SwitchControl on={breaks} label="Agents waiting on you break through DND" onChange={(v) => instantSave(breaks, v, (x) => setBreakThrough(x as boolean))} />} />
        <Disclosure label={`Interrupt me for · ${NOTIFY_KINDS.length} kinds`}>
          {NOTIFY_KINDS.map((k) => (
            <SettingRow key={k} kind="control" agentExempt label={NOTIFY_KIND_LABEL[k].label} help={NOTIFY_KIND_LABEL[k].desc}
              control={<SwitchControl on={prefs.kinds[k]} label={NOTIFY_KIND_LABEL[k].label} disabled={prefs.none && k !== "blocked"} onChange={(n) => setKind(k, n)} />} />
          ))}
        </Disclosure>
        <Disclosure label="Channels · desktop popup, title-bar chip, bell">
          {NOTIFY_CHANNELS.filter((ch) => ch !== "sound").map((ch) => (
            <SettingRow key={ch} kind="control" agentExempt label={NOTIFY_CHANNEL_LABEL[ch].label} help={NOTIFY_CHANNEL_LABEL[ch].desc}
              control={<SwitchControl on={prefs.channels[ch]} label={NOTIFY_CHANNEL_LABEL[ch].label} onChange={(n) => setChannel(ch, n)} />} />
          ))}
        </Disclosure>
        <Disclosure label="Paired phones">
          <SettingRow kind="control" settingId="phone.alerts" label="Paired phones" help={help("more", "Paired phones")}
            control={<SwitchControl on={phone === true} label="Paired phones" disabled={phone === null} onChange={writePhone} />} />
        </Disclosure>
      </Section>
    ) },
    { id: "asked", title: "Asked for", kind: "normal", body: (
      <Section id="asked" title="Asked for" intro={help("asked", "Alerts you armed")}>
        <div className="px-3 py-2.5" style={{ borderTop: LINE }}><AskedAlertLog /></div>
      </Section>
    ) },
    { id: "sound", title: "Sound", kind: "normal", body: (
      <Section id="sound" title="Sound">
        <SettingRow kind="control" agentExempt label={NOTIFY_CHANNEL_LABEL.sound.label} help="A chime with each pop-up."
          control={<SwitchControl on={prefs.channels.sound} label={NOTIFY_CHANNEL_LABEL.sound.label} disabled={prefs.none} onChange={(n) => setChannel("sound", n)} />} />
        <SettingRow agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence" kind="control" label="Notification sound" help={help("sound", "Notification sound")}
          control={<VoicePicker label="Notifications" voices={NOTIFY_VOICES} value={notifyVoice}
            onPick={(v) => instantSave(notifyVoice, v, (x) => { setNotifyVoice(x); setNotifyVoiceState(x); })} />} />
        <SettingRow kind="control" agentExempt label="Chime this session" help={help("sound", "Chime this session")}
          control={<SwitchControl on={sound} label="Chime this session" onChange={() => onSound()} />} />
        <SettingRow agentNever="decides whether an agent blocked on the owner can reach them: notifications are the owner's to silence" kind="control" label="Alarm voice" help={help("sound", "Alarm voice")}
          control={<VoicePicker label="Reminder alarm" voices={ALARM_VOICES} value={alarmVoice}
            onPick={(v) => instantSave(alarmVoice, v, (x) => { setAlarmVoice(x); setAlarmVoiceState(x); })} />} />
      </Section>
    ) },
  ];

  return (
    <>
      <SettingsPage title="Notifications" purpose={NOTIFICATIONS_PURPOSE} sections={sections} />
      <SaveToastHost />
    </>
  );
}
