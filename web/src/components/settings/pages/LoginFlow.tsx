/*
 * Settings ▸ Browser ▸ Login vault, drawn as what it is (mockup direction C,
 * "Flow"): your browsers feed the vault, agents draw from it. Import and the
 * agent rules read as one sentence each, with the choices as slots.
 *
 * Every number here comes from the same calls the rows used before
 * (cookieSources, ag:vaultList, vaultSignedIn): this file only draws them.
 */
import { useId, type ReactNode } from "react";
import { rowId } from "../../../lib/settingsIndex.ts";
import { ago, type SignedInCard, type VaultBox } from "../../../lib/loginVault.ts";
import type { CookieSource } from "../../../lib/desktop.ts";
import { AgentIcon, ClockIcon, CrossIcon, DoneIcon, LockIcon, RefreshIcon, StashIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { Select, type SelectOption } from "../../Select.tsx";
import { Button, LINE } from "../../workspace/Chrome.tsx";

export const FLOW_CSS = `
.agx-vf{container:agx-vf / inline-size}
.agx-vf-grid{display:grid;grid-template-columns:minmax(0,1fr) 36px minmax(0,1.1fr) 36px minmax(0,1fr);align-items:start}
.agx-vf-col{display:flex;flex-direction:column;gap:8px;min-width:0}
.agx-vf-h{font-size:10px;line-height:18px;height:18px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text3)}
.agx-vf-box{display:flex;align-items:center;gap:8px;height:72px;padding:0 8px 0 10px;border-radius:12px;background:var(--surface-card);border:${LINE};min-width:0;transition:border-color .18s ease}
.agx-vf-box:hover{border-color:color-mix(in srgb,var(--text) 22%,transparent)}
.agx-vf-box.locked{background:repeating-linear-gradient(135deg,transparent 0 7px,color-mix(in srgb,var(--text) 4%,transparent) 7px 8px),var(--surface-card)}
.agx-vf-box .agx-vf-sub{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal;line-height:14px}
.agx-vf-quiet{display:flex;align-items:center;height:72px;padding:0 2px;font-size:12px;color:var(--text3)}
.agx-vf-vslot{display:flex;flex-direction:column;justify-content:center}
.agx-vf-vault{border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px;border:${LINE};box-shadow:0 1px 2px rgb(0 0 0 / .12),0 8px 24px -8px rgb(0 0 0 / .28);background:radial-gradient(120% 100% at 50% 0%,color-mix(in srgb,var(--primary) 12%,transparent),transparent 60%),var(--surface-card)}
.agx-vf-wire{position:relative;align-self:stretch}
.agx-vf-wire svg{position:absolute;left:0;top:26px;width:100%;overflow:visible}
.agx-vf-wire path{fill:none;stroke:color-mix(in srgb,var(--text) 22%,transparent);stroke-width:1.5}
.agx-vf-wire path.live{stroke:var(--success);stroke-width:2}
.agx-vf-wire path.dead{stroke-dasharray:3 4}
.agx-vf-now{grid-column:1/-1;margin-top:14px}
.agx-vf-sent{font-size:14px;line-height:30px;color:var(--text2);margin:0}
.agx-vf-sent .agx-vf-slot{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:7px;vertical-align:middle;font-size:13px;font-weight:600;line-height:1;color:var(--text);max-width:100%;
  background:color-mix(in srgb,var(--primary) 12%,var(--surface-card));
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--primary) 45%,transparent)}
.agx-vf-sent .agx-vf-slot:hover:not(:disabled){box-shadow:inset 0 0 0 1px var(--primary)}
.agx-vf-sent .agx-vf-slot:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.agx-vf-sent .agx-vf-slot.off{background:none;box-shadow:inset 0 0 0 1px var(--border2);color:var(--text3);font-weight:500}
.agx-vf-sent .agx-vf-slot.off s{text-decoration-thickness:1.5px}
.agx-vf-sent .agx-vf-slot-i{color:var(--primary);display:inline-flex}
.agx-vf-sent .agx-vf-slot.off .agx-vf-slot-i{color:var(--text3)}
.agx-vf-sent .agx-vf-hug{white-space:nowrap}
@container agx-vf (max-width: 560px){
  .agx-vf-grid{grid-template-columns:minmax(0,1fr)}
  .agx-vf-wire{height:18px}
  .agx-vf-wire svg{display:none}
  .agx-vf-wire::after{content:"";display:block;margin:2px auto;width:1.5px;height:14px;background:var(--border2)}
  .agx-vf-quiet{height:auto;padding:4px 2px}
  .agx-vf-vslot{height:auto!important}
}
@media (prefers-reduced-motion: reduce){.agx-vf-box{transition:none}}
`;

/* Row geometry the wires are drawn against: a 72px box and an 8px gap. */
const ROW = 80;
const HEAD = 26;
/* The vault card's own height with two browsers in it: header, count and two rows. */
const VAULT_MIN = 184;

const hueOf = (s: string): number => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };

/** A browser or a site, as the first letter on its own hue. Decorative: the name is always beside it. */
export function Initial({ name, size = 28, round = false }: { name: string; size?: number; round?: boolean }) {
  const h = hueOf(name);
  return (
    <span aria-hidden className="grid shrink-0 place-items-center font-bold"
      style={{ width: size, height: size, borderRadius: round ? "50%" : Math.round(size * 0.28), fontSize: Math.round(size * 0.43),
        background: `hsl(${h} 55% 50% / .16)`, color: `color-mix(in srgb, hsl(${h} 60% 40%) 70%, var(--text))`, boxShadow: `inset 0 0 0 1px hsl(${h} 30% 50% / .2)` }}>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

type G = { size?: number };
const stroke = (size: number) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true });
export function TrashGlyph({ size = ICON.sm }: G) { return <svg {...stroke(size)}><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6" /></svg>; }
export function SignOutGlyph({ size = ICON.sm }: G) { return <svg {...stroke(size)}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10" /></svg>; }
export function SignInGlyph({ size = ICON.sm }: G) { return <svg {...stroke(size)}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l4 4-4 4M4 12h10" /></svg>; }
export function DownGlyph({ size = ICON.sm }: G) { return <svg {...stroke(size)}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>; }
export function KeyGlyph({ size = ICON.xs }: G) { return <svg {...stroke(size)}><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 8.7-8.7M17 6l2.5 2.5M14.5 8.5 16.5 10.5" /></svg>; }

type SlotBase = { label: string; help: string; /** Kept for the settings index: the reason an agent never reaches this slot. */ agentNever?: string; small?: boolean };
/**
 * One choice inside a sentence. A switch reads its own words for on and off
 * ("sign it out" / "keep it signed in"); a select is the house Select dressed
 * as a slot. `label` and `help` are the row's words: the accessible name, the
 * description, and the anchor a settings search jumps to.
 */
export function SentenceSlot(p: SlotBase & ({ kind: "switch"; on: boolean; onText: string; offText: string; strike?: boolean; icon?: ReactNode; disabled?: boolean; onChange: (on: boolean) => void }
  | { kind: "select"; value: string; options: SelectOption[]; disabled?: boolean; lead?: ReactNode; onChange: (v: string) => void })) {
  const helpId = useId();
  const help = <span id={helpId} className="sr-only">{p.help}</span>;
  if (p.kind === "select") {
    const cur = p.options.find((o) => o.value === p.value);
    return (
      <span data-row={rowId(p.label)} data-flow-slot className="inline-flex max-w-full align-middle" aria-describedby={helpId}>
        {help}
        <Select value={p.value} options={p.options} disabled={p.disabled} onChange={p.onChange} title={`${p.label}: ${cur?.label ?? ""}`}
          className="agx-vf-slot" trigger={<>{p.lead}<span className="truncate">{cur?.label ?? ""}</span></>} />
      </span>
    );
  }
  return (
    <span data-row={rowId(p.label)} data-flow-slot className="inline-flex max-w-full align-middle">
      {help}
      <button type="button" role="switch" aria-checked={p.on} aria-label={p.label} aria-describedby={helpId} disabled={p.disabled}
        className={`agx-vf-slot${p.on ? "" : " off"}`} onClick={() => p.onChange(!p.on)}>
        <span className="agx-vf-slot-i">{p.icon ?? (p.on ? <DoneIcon size={ICON.sm} /> : <CrossIcon size={ICON.sm} />)}</span>
        {p.on ? p.onText : p.strike ? <s>{p.offText}</s> : p.offText}
      </button>
    </span>
  );
}

/** The line under the flow that says what is true right now. */
export function NowLine({ live, children }: { live: boolean; children: ReactNode }) {
  return (
    <span role="status" className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-[12px]" style={{ color: "var(--text2)" }}>
      {live && <span aria-hidden className="rounded-full" style={{ width: 7, height: 7, background: "var(--success)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--success) 20%, transparent)" }} />}
      <span className="px-0.5 font-sans text-[10px] font-bold uppercase tracking-[.08em]" style={{ color: "var(--text3)" }}>Now</span>
      <span>{children}</span>
    </span>
  );
}

function Wires({ rows, height, left, live, dead }: { rows: number; height: number; left: boolean; live: (i: number) => boolean; dead: (i: number) => boolean }) {
  const mid = height / 2;
  return (
    <div className="agx-vf-wire" aria-hidden>
      <svg viewBox={`0 0 56 ${height}`} preserveAspectRatio="none" style={{ height }}>
        {Array.from({ length: rows }, (_, i) => {
          const y = 36 + i * ROW;
          const d = left ? `M0 ${y} C 30 ${y}, 26 ${mid}, 56 ${mid}` : `M0 ${mid} C 30 ${mid}, 26 ${y}, 56 ${y}`;
          return <path key={i} className={`${live(i) ? "live" : ""}${dead(i) ? " dead" : ""}`} d={d} />;
        })}
      </svg>
    </div>
  );
}

export type FlowProps = {
  sources: readonly CookieSource[];
  boxes: readonly VaultBox[];
  signed: readonly SignedInCard[];
  /** The vault did not open: main's words for why. */
  locked: string | null;
  sites: number;
  sensitive: number;
  now: number;
  busy: boolean;
  onImportFrom: (source: string) => void;
  onRefresh: (b: VaultBox) => void;
  onRemove: (b: VaultBox) => void;
  onSignOut: (c: SignedInCard) => void;
  onRetry: () => void;
  nowLine: ReactNode;
};

/** Why a browser cannot be read, short enough for its card. */
export function shortLocked(s: CookieSource): string {
  if (s.reason === "app-bound") return "Locked · app-bound encryption";
  if (s.reason === "v11-keyring") return "Locked · unlock your keyring";
  return "Locked · its cookies will not decrypt";
}

/** Your browsers → the vault → agents signed in, with a wire per link. No placeholder boxes: an empty column says so in one quiet line. */
export function VaultFlow(p: FlowProps) {
  const rows = Math.max(2, p.sources.length, p.signed.length);
  // The wires meet the vault at the middle of this height; the vault card itself is only as tall as its words, centred on it.
  const height = Math.max(rows * ROW - 8, VAULT_MIN);
  const readAt = (id: string) => p.boxes.find((b) => b.source === id)?.updatedAt ?? null;
  const filled = p.boxes.length > 0;
  return (
    <div data-vault-flow className="agx-vf px-4 py-4">
      <div className="agx-vf-grid">
        <div className="agx-vf-col" role="group" aria-label="Your browsers">
          <div className="agx-vf-h">Your browsers</div>
          {!p.sources.length && <div className="agx-vf-quiet">No browser found on this machine</div>}
          {p.sources.map((s) => {
            const at = readAt(s.id);
            // A locked browser says why in a few words; the whole reason shows under the import sentence once it is picked.
            const sub = s.readable ? `${s.sites.length} site${s.sites.length === 1 ? "" : "s"}${at ? ` · read ${ago(at, p.now)}` : ""}` : shortLocked(s);
            return (
              <div key={s.id} data-flow-source={s.id} className={`agx-vf-box${s.readable ? "" : " locked"}`}>
                <Initial name={s.label} size={26} />
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-[12.5px] font-semibold leading-[16px]" style={{ color: "var(--text)" }} data-tip={s.label} data-tip-unless-shown=".truncate">{s.label}</b>
                  <span className="agx-vf-sub text-[11.5px]" style={{ color: "var(--text3)" }}>{sub}</span>
                </span>
                {s.readable
                  ? <Button size="hit" square tone="quiet" label={`Import from ${s.label}`} disabled={p.busy || !s.sites.length} onClick={() => p.onImportFrom(s.id)}><DownGlyph /></Button>
                  : <span className="inline-flex shrink-0" style={{ color: "var(--text3)" }}><LockIcon size={ICON.sm} /><span className="sr-only">Locked</span></span>}
              </div>
            );
          })}
        </div>
        <Wires rows={Math.max(1, p.sources.length)} height={height} left live={(i) => !!p.sources[i]?.readable && filled} dead={(i) => !p.sources[i]?.readable} />
        <div className="agx-vf-col" role="group" aria-label="The vault">
          <div className="agx-vf-h">The vault</div>
          <div className="agx-vf-vslot" style={{ height }}>
          <div data-flow-vault className="agx-vf-vault">
            <div className="flex items-center gap-2.5">
              <span className="grid shrink-0 place-items-center rounded-lg" style={{ width: 32, height: 32, background: "color-mix(in srgb, var(--primary) 14%, transparent)", color: "color-mix(in srgb, var(--primary) 60%, var(--text))" }}><StashIcon size={ICON.lg} /></span>
              <div className="min-w-0">
                <b className="block text-[13px]" style={{ color: "var(--text)" }}>Login vault</b>
                <div className="truncate text-[11.5px]" style={{ color: "var(--text3)" }}>Encrypted · key in keyring</div>
              </div>
            </div>
            {p.locked !== null ? (
              <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-[12.5px]" style={{ color: "var(--error-ink)" }}>
                <LockIcon size={ICON.lg} />
                <b>Locked: {p.locked}</b>
                <Button size="compact" disabled={p.busy} onClick={p.onRetry}>Try again</Button>
              </div>
            ) : !filled ? (
              <div className="grid flex-1 place-items-center text-center text-[12.5px]" style={{ color: "var(--text3)" }}>Empty. Import fills it.</div>
            ) : (
              <>
                <div className="flex flex-wrap items-baseline gap-x-1.5">
                  <b className="tabular-nums text-[34px] font-bold leading-none tracking-[-.03em]" style={{ color: "var(--text)" }}>{p.sites}</b>
                  <span className="whitespace-nowrap text-[12.5px]" style={{ color: "var(--text2)" }}>site{p.sites === 1 ? "" : "s"}</span>
                  <span className="inline-flex items-center gap-1 whitespace-nowrap text-[12.5px]" style={{ color: "var(--warning-ink)" }}><LockIcon size={ICON.xs} />{p.sensitive} sensitive</span>
                </div>
                <div className="flex flex-col gap-1">
                  {p.boxes.map((b) => (
                    <div key={b.source} data-flow-box={b.source} className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text2)" }}>
                      <Initial name={b.label} size={20} round />
                      <span className="min-w-0 flex-1 leading-[16px]" data-tip={`${b.label} · ${b.sites.length} · ${ago(b.updatedAt, p.now)}`} data-tip-unless-shown=".truncate"><span className="block truncate"><b style={{ color: "var(--text)" }}>{b.label}</b>{` · ${b.sites.length} · ${ago(b.updatedAt, p.now)}`}</span></span>
                      <Button size="hit" square tone="quiet" label={`Refresh from ${b.label}`} disabled={p.busy || b.pending} onClick={() => p.onRefresh(b)}><RefreshIcon size={ICON.sm} /></Button>
                      <Button size="hit" square tone="quiet" label={`Remove ${b.label} from the vault`} disabled={p.busy || b.pending} onClick={() => p.onRemove(b)}><TrashGlyph /></Button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          </div>
        </div>
        <Wires rows={Math.max(1, p.signed.length)} height={height} left={false} live={(i) => !!p.signed[i]} dead={(i) => !p.signed[i]} />
        <div className="agx-vf-col" role="group" aria-label="Agents signed in">
          <div className="agx-vf-h">Agents signed in</div>
          {!p.signed.length && <div className="agx-vf-quiet">{filled ? "No agent signed in" : "No agent can sign in yet"}</div>}
          {p.signed.map((c) => (
            <div key={`${c.lane}-${c.site}`} data-vault-signed-in={c.lane} className="agx-vf-box">
              <span className="grid shrink-0 place-items-center rounded-lg" style={{ width: 26, height: 26, background: "color-mix(in srgb, var(--success) 16%, transparent)", color: "var(--success-ink)" }}><AgentIcon size={ICON.sm} /></span>
              <span className="min-w-0 flex-1">
                <b className="block truncate text-[12.5px] font-semibold leading-[16px]" style={{ color: "var(--text)" }}>{c.agent || "An agent"}</b>
                <span className="agx-vf-sub text-[11.5px]" style={{ color: "var(--text3)" }}><span className="whitespace-nowrap">{c.site}</span>{c.at ? <>{" "}<span className="whitespace-nowrap">{`· ${ago(c.at, p.now)}`}</span></> : null}</span>
              </span>
              <Button size="hit" square tone="quiet" style={{ color: "var(--error-ink)" }} label={`Sign ${c.agent || "the agent"} out of ${c.site} now`} disabled={p.busy} onClick={() => p.onSignOut(c)}><SignOutGlyph /></Button>
            </div>
          ))}
        </div>
        <div className="agx-vf-now">{p.nowLine}</div>
      </div>
    </div>
  );
}

/** A slot the vault list leaves when it has nothing to show: empty, or locked. */
export function VaultSlot({ tone, title, children, actions }: { tone: "empty" | "error"; title: string; children: ReactNode; actions: ReactNode }) {
  const err = tone === "error";
  return (
    <div role={err ? "alert" : "status"} data-vault-slot={tone} className="m-3 flex flex-col items-center justify-center gap-2 rounded-xl p-6 text-center"
      style={{ minHeight: 200, border: `1.5px dashed ${err ? "color-mix(in srgb, var(--error) 45%, transparent)" : "var(--border2)"}`, background: err ? "color-mix(in srgb, var(--error) 7%, transparent)" : undefined, color: "var(--text2)" }}>
      <span className="grid place-items-center rounded-xl" style={{ width: 44, height: 44, background: "var(--surface-inset)", color: err ? "var(--error-ink)" : "var(--text3)" }}>{err ? <LockIcon size={ICON.xl} /> : <StashIcon size={ICON.xl} />}</span>
      <b className="text-[14px]" style={{ color: "var(--text)" }}>{title}</b>
      <p className="m-0 max-w-[46ch] text-[12.5px]">{children}</p>
      <div className="mt-1 flex flex-wrap justify-center gap-2">{actions}</div>
    </div>
  );
}

/** An agent asked for a site whose vault login has expired. */
export function AskCard({ title, children, actions }: { title: string; children: ReactNode; actions: ReactNode }) {
  return (
    <div role="status" className="mx-4 mb-3 flex flex-wrap items-center gap-3 rounded-xl px-3.5 py-3"
      style={{ background: "color-mix(in srgb, var(--warning) 12%, var(--surface-card))", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--warning) 25%, transparent)" }}>
      <span className="grid shrink-0 place-items-center rounded-lg" style={{ width: 30, height: 30, background: "var(--surface-card)", color: "var(--warning-ink)" }}><ClockIcon size={ICON.md} /></span>
      <span className="min-w-0 flex-1 text-[12.5px]">
        <b className="block font-semibold" style={{ color: "var(--text)" }}>{title}</b>
        <span className="text-[12px]" style={{ color: "var(--text2)" }}>{children}</span>
      </span>
      <span className="flex shrink-0 gap-1.5">{actions}</span>
    </div>
  );
}
