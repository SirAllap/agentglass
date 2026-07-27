import { Act, Empty } from "./mobileUi.tsx";
import { fmtAgo } from "../lib/format.ts";
import type { NowItem, NowTone } from "./nowQueue.ts";

/**
 * The queue, and the hero above it.
 *
 * Every card is one decision with its action on it, and answering one takes it
 * out of the list. That is the whole difference between this and a dashboard:
 * a dashboard is something you re-read, and this is something you can empty.
 *
 * The stripe down the left encodes urgency in width as well as colour, so the
 * ordering is legible at a glance and not only to someone who can tell amber
 * from pink at arm's length in the sun.
 */
export const NOW_CSS = `
.mb-hero{position:relative;border-radius:20px;overflow:hidden;margin-bottom:16px;
  background:linear-gradient(165deg,color-mix(in srgb,var(--bg3) 60%,transparent),color-mix(in srgb,var(--bg2) 72%,transparent));
  border:1px solid color-mix(in srgb,var(--border) 46%,transparent);box-shadow:var(--mb-edge),var(--mb-drop)}
.mb-hero::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(180deg,color-mix(in srgb,var(--primary) 7%,transparent),transparent 42%)}
.mb-hero .in{position:relative;z-index:1;padding:17px 17px 0;display:flex;align-items:flex-end;gap:12px}
.mb-hero .n{font-size:50px;color:var(--text)}
.mb-hero.calm .n{font-size:38px;color:var(--success)}
.mb-hero .w{padding-bottom:7px;min-width:0}
.mb-hero .w b{display:block;font-size:14px;font-weight:600;line-height:1.25}
.mb-hero .w span{display:block;font-size:11.5px;color:var(--text3);margin-top:2px}

/* Vitals: one bar per live agent, each on its own period, so the strip reads
   as several things working rather than as one animation looping. */
.mb-vitals{display:flex;align-items:flex-end;gap:3px;height:46px;margin:16px 17px 0;padding-bottom:7px;
  position:relative;z-index:1;border-bottom:1px solid color-mix(in srgb,var(--border) 40%,transparent)}
.mb-vitals i{flex:1;height:100%;border-radius:2px 2px 0 0;transform-origin:bottom;
  background:linear-gradient(180deg,var(--primary-hover),color-mix(in srgb,var(--primary) 26%,transparent));
  animation:mb-vit var(--p) ease-in-out infinite;animation-delay:var(--d);
  box-shadow:0 0 10px -2px color-mix(in srgb,var(--primary) 60%,transparent)}
@keyframes mb-vit{0%,100%{transform:scaleY(.14)}50%{transform:scaleY(1)}}
.mb-vitals i.idle{background:color-mix(in srgb,var(--border) 48%,transparent);animation:none;
  transform:scaleY(.1);box-shadow:none}
.mb-vlabel{display:flex;align-items:center;gap:8px;padding:11px 17px 16px;font-size:10.5px;
  color:var(--text3);position:relative;z-index:1}
.mb-vlabel b{color:var(--text2);font-weight:500}

.mb-item{position:relative;border-radius:18px;overflow:hidden;background:var(--mb-card);
  border:1px solid color-mix(in srgb,var(--border) 38%,transparent);
  box-shadow:var(--mb-edge),var(--mb-drop);animation:mb-rise .42s cubic-bezier(.2,.85,.25,1) backwards}
@keyframes mb-rise{from{opacity:0;transform:translateY(14px) scale(.985)}}
.mb-item::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--text3)}
.mb-item.crit{border-color:color-mix(in srgb,var(--warning) 52%,transparent);
  background:color-mix(in srgb,var(--warning) 10%,var(--bg2));
  box-shadow:var(--mb-edge),0 14px 34px -18px color-mix(in srgb,var(--warning) 55%,#000)}
.mb-item.crit::before{width:5px;background:var(--warning)}
.mb-item.bad::before{background:var(--error)}
.mb-item.good::before{background:var(--success)}
.mb-item .ih{display:flex;align-items:baseline;gap:9px;padding:13px 14px 0 17px}
.mb-item .k{font-size:9.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);font-weight:600}
.mb-item.crit .k{color:var(--warning)}
.mb-item.bad .k{color:var(--error)}
.mb-item.good .k{color:var(--success)}
.mb-item .at{margin-left:auto;font-size:10.5px;color:var(--text3);white-space:nowrap}
.mb-item .t{padding:6px 14px 0 17px;font-size:14.5px;line-height:1.38;color:var(--text);text-wrap:balance;
  overflow-wrap:anywhere}
.mb-item .s{padding:6px 14px 0 17px;font-size:11.5px;color:var(--text3);line-height:1.5;overflow-wrap:anywhere}
.mb-item .code{margin:9px 14px 0 17px;padding:9px 11px;border-radius:9px;font-size:11px;color:var(--warning);
  background:color-mix(in srgb,#000 40%,transparent);overflow-wrap:anywhere;
  border-left:2px solid color-mix(in srgb,var(--warning) 55%,transparent)}
.mb-item .acts{display:flex;gap:9px;padding:13px 14px 14px 17px}
.mb-item .acts>*{flex:1;min-height:50px;border-radius:13px}
`;

export interface NowAction {
  label: string;
  kind?: "acc" | "ok" | "no" | "dang";
  run: () => Promise<string | void> | string | void;
}

export function NowHero({ pending, working, rates, spend, repos }: {
  pending: number; working: number; rates: number[]; spend: string; repos: string[];
}) {
  const calm = pending === 0;
  // A fixed number of slots, so the strip has the same shape whether one agent
  // is running or six — it reads as capacity, not as a bar chart that resizes.
  const SLOTS = 14;
  return (
    <div className={`mb-hero${calm ? " calm" : ""}`}>
      <div className="in">
        <span className="mb-fig n">{calm ? "✓" : pending}</span>
        <span className="w">
          <b>{calm ? "Nothing needs you" : `${pending} thing${pending > 1 ? "s" : ""} want${pending > 1 ? "" : "s"} you`}</b>
          <span>{calm ? "The fleet is running clean" : "Answer one and it leaves the queue"}</span>
        </span>
      </div>
      <div className="mb-vitals" aria-hidden="true">
        {Array.from({ length: SLOTS }, (_, i) => {
          const r = rates[i];
          return r == null
            ? <i key={i} className="idle" />
            : <i key={i} style={{ ["--p" as string]: `${(1.6 / r).toFixed(2)}s`, ["--d" as string]: `${(i * 0.23).toFixed(2)}s` }} />;
        })}
      </div>
      <div className="mb-vlabel">
        <span className="mb-dot pulse" style={{ background: working ? "var(--success)" : "var(--text3)", color: "var(--success)" }} />
        <b>{working} working</b><span>·</span><span>{spend} today</span>
        <span className="flex-1" />
        <span className="truncate">{repos.slice(0, 2).join(", ")}</span>
      </div>
    </div>
  );
}

export function NowStream({ items, actionsFor, onOpen }: {
  items: NowItem[];
  actionsFor: (it: NowItem) => NowAction[];
  onOpen: (it: NowItem) => void;
}) {
  if (!items.length) {
    return (
      <Empty glyph="◎" title="The queue is empty"
        body="You will hear about it when an agent stops, asks permission, turns something red, or opens something worth your eyes." />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {items.map((it, i) => (
        <div key={it.id} className={`mb-item ${toneClass(it.tone)}`} style={{ animationDelay: `${i * 55}ms` }}>
          <div className="ih">
            <span className="k">{it.kind}</span>
            <span className="at">{fmtAgo(it.ts)}</span>
          </div>
          <button className="t mb-press w-full text-left" style={{ background: "transparent" }} onClick={() => onOpen(it)}>
            {it.title}
          </button>
          <div className="s">{it.sub}</div>
          {it.code && <div className="code">{it.code}</div>}
          <div className="acts">
            {actionsFor(it).map((a) => (
              <Act key={a.label} kind={a.kind} onAct={a.run}>{a.label}</Act>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const toneClass = (t: NowTone) => (t === "plain" ? "" : t);
