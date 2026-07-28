import { Act, Empty } from "./mobileUi.tsx";
import { fmtAgo } from "../lib/format.ts";
import { shortTarget } from "./transcript.ts";
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

/* What is open right now: one row per running tool call, from the socket. Not
   a chart — the useful facts are which tool, what it is touching, and how long
   it has been at it, and none of those is a magnitude. */
.mb-open{position:relative;z-index:1;margin:15px 17px 0;padding-bottom:9px;
  border-bottom:1px solid color-mix(in srgb,var(--border) 40%,transparent);
  display:flex;flex-direction:column;gap:6px}
.mb-open .r{display:flex;align-items:center;gap:8px;font-size:11px;min-width:0}
.mb-open .r b{color:var(--primary-hover);font-weight:700;flex:none}
.mb-open .r .t{color:var(--text2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.mb-open .r .o{flex:none;color:var(--text3);font-variant-numeric:tabular-nums;font-size:10px}
.mb-open .r .o.long{color:var(--warning)}
.mb-open .more{font-size:10px;color:var(--text3)}
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
/* The whole header is the way in, so it is one target and it is comfortably
   over 44px — the title alone was 26. */
.mb-item .tt{display:block;padding:6px 0 4px}
.mb-item .t{display:block;padding:0 14px 0 17px;font-size:14.5px;line-height:1.38;color:var(--text);
  text-wrap:balance;overflow-wrap:anywhere}
.mb-item .s{display:block;padding:6px 14px 0 17px;font-size:11.5px;color:var(--text3);line-height:1.5;
  overflow-wrap:anywhere}
.mb-item .code{margin:9px 14px 0 17px;padding:9px 11px;border-radius:9px;font-size:11px;color:var(--warning);
  background:color-mix(in srgb,#000 40%,transparent);overflow-wrap:anywhere;
  border-left:2px solid color-mix(in srgb,var(--warning) 55%,transparent)}
.mb-item .acts{display:flex;gap:9px;padding:13px 14px 14px 17px}
.mb-item .acts>*{flex:1;min-height:50px;border-radius:13px}
/* "Later" sits beside the real answers rather than sharing their width: three
   equal thirds put "See the log" on two lines, and putting something away is
   not the same size of decision as re-running it. */
.mb-item .acts>.tight{flex:none;display:flex}
.mb-item .acts>.tight>.mb-btn{min-height:50px;border-radius:13px;padding:0 15px}
`;

export interface NowAction {
  label: string;
  kind?: "acc" | "ok" | "no" | "dang";
  /** Sized to its own label instead of taking an equal share of the row. */
  tight?: boolean;
  run: () => Promise<string | void> | string | void;
}

/**
 * The hero, and under it what the fleet is actually doing.
 *
 * This used to draw fourteen bars animated at rates derived from each session's
 * tool *count* — `1 + ((s.tool_count % 5) * 0.35)`. They were `aria-hidden`
 * decoration presented in the position telemetry would occupy, on an app that
 * had no live connection and therefore nothing to tell you. Someone glancing at
 * a phone to see whether an agent was moving was reading an animation.
 *
 * The socket carries the real answer: `openTools` is the server's authoritative
 * list of calls still running, with what each one is touching and when that
 * session last showed evidence of being alive. So the strip is now one row per
 * open call, and when nothing is open it says so instead of pulsing.
 */
export function NowHero({ pending, working, live, spend, repos }: {
  pending: number; working: number; live: LiveCall[]; spend: string; repos: string[];
}) {
  const calm = pending === 0;
  return (
    <div className={`mb-hero${calm ? " calm" : ""}`}>
      <div className="in">
        <span className="mb-fig n">{calm ? "✓" : pending}</span>
        <span className="w">
          <b>{calm ? "Nothing needs you" : `${pending} thing${pending > 1 ? "s" : ""} want${pending > 1 ? "" : "s"} you`}</b>
          <span>{calm ? "The fleet is running clean" : "Answer one and it leaves the queue"}</span>
        </span>
      </div>
      {live.length > 0 && (
        <div className="mb-open">
          {live.slice(0, 3).map((c) => (
            <div className="r" key={c.key}>
              <b>{c.tool}</b>
              {/* Shortened here rather than with `direction: rtl`, which does
                  keep the filename but re-orders the leading slash of an
                  absolute path to the end — `…/live/root/shared/types.ts/`.
                  Bidi reordering is not a truncation strategy. */}
              <span className="t">{shortTarget(c.target) || c.app}</span>
              {/* How long it has been open is the difference between thinking
                  and stuck, and it is the one number a count cannot give you. */}
              <span className={`o${c.openMs > 60_000 ? " long" : ""}`}>{fmtAgo(Date.now() - c.openMs)}</span>
            </div>
          ))}
          {live.length > 3 && <div className="more">+{live.length - 3} more open</div>}
        </div>
      )}
      <div className="mb-vlabel">
        <span className="mb-dot pulse" style={{ background: working ? "var(--success)" : "var(--text3)", color: "var(--success)" }} />
        <b>{working} working</b><span>·</span><span>{spend} today</span>
        <span className="flex-1" />
        <span className="truncate">{repos.slice(0, 2).join(", ")}</span>
      </div>
    </div>
  );
}

/** One open tool call, reduced to what the strip draws. */
export interface LiveCall {
  key: string;
  tool: string;
  target: string | null;
  app: string;
  /** How long the call has been open, in ms. */
  openMs: number;
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
          {/* Title and subtitle are one target, not a 26px line of text with
              dead space under it. A queue card's whole point is that you can
              open it, and the only way in was a strip barely half a fingertip
              tall — which on a card you are already scrolling past is a miss
              more often than a hit. */}
          <button className="tt mb-press w-full text-left" style={{ background: "transparent" }} onClick={() => onOpen(it)}>
            <span className="t">{it.title}</span>
            <span className="s">{it.sub}</span>
          </button>
          {it.code && <div className="code">{it.code}</div>}
          <div className="acts">
            {actionsFor(it).map((a) => (a.tight
              ? <span className="tight" key={a.label}><Act kind={a.kind} onAct={a.run}>{a.label}</Act></span>
              : <Act key={a.label} kind={a.kind} onAct={a.run}>{a.label}</Act>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const toneClass = (t: NowTone) => (t === "plain" ? "" : t);
