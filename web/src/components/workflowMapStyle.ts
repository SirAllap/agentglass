/*
 * The ClickUp page's states that an inline style cannot say: hover, press, focus,
 * a dimmed connector. Everything is in the house tokens (--bg, --surface-*, --primary,
 * --success/--warning/--error and their -ink), so a theme restyles it with the rest
 * of the app; the only numbers are the 4/8/12/16/24 spacing steps and the 10/11/13
 * type steps of the design this page follows.
 *
 * Class names are `wfm-` so nothing here reaches a control elsewhere.
 */
import { EDGE, LINE, tintEdge } from "./workspace/Chrome.tsx";

export const WFM_CSS = `
.wfm{--w-wash:color-mix(in srgb,var(--primary) 11%,var(--bg));--w-wash2:color-mix(in srgb,var(--primary) 20%,var(--bg));
--w-ok-wash:color-mix(in srgb,var(--success) 16%,var(--bg));--w-warn-wash:color-mix(in srgb,var(--warning) 16%,var(--bg));--w-err-wash:color-mix(in srgb,var(--error) 11%,var(--bg));
--w-edge:color-mix(in srgb,var(--text) 24%,transparent);--w-ring:0 0 0 2px var(--bg),0 0 0 4px var(--primary);--w-ease:cubic-bezier(.23,1,.32,1);--w-line:var(--surface-line);--w-rule:${LINE};--w-outline:${EDGE};--w-tint:${tintEdge("var(--primary)", 55)}}
.wfm{line-height:1.5}
.wfm *{box-sizing:border-box}
.wfm button:focus-visible,.wfm summary:focus-visible,.wfm [tabindex]:focus-visible{outline:none;box-shadow:var(--w-ring)}
.wfm-grid{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:48px;align-items:start}
.wfm-steps{display:flex;flex-direction:column;gap:16px;min-width:0}
.wfm-lines{position:absolute;left:0;top:0;pointer-events:none;z-index:6;overflow:visible}
.wfm-ln{opacity:.7;transition:opacity .15s}.wfm-ln path{fill:none;stroke-width:1.75;transition:stroke-width .15s}
.wfm-lines[data-has] .wfm-ln{opacity:.12}.wfm-lines[data-has] .wfm-ln[data-hl]{opacity:1}.wfm-ln[data-hl] path{stroke-width:2.75}
.wfm-lines[data-off] path{stroke-dasharray:4 4}
.wfm-step{position:relative;background:var(--bg);border-radius:12px;box-shadow:0 0 0 1px var(--w-edge),0 1px 2px rgba(0,0,0,.08);transition:box-shadow .15s,background .15s}
.wfm-step:hover,.wfm-step[data-hl],.wfm-step:focus-within{box-shadow:0 0 0 1px var(--primary),0 0 0 4px color-mix(in srgb,var(--primary) 16%,transparent),0 6px 18px -12px rgba(0,0,0,.4)}
.wfm-step[data-need]{box-shadow:0 0 0 1px var(--warning),0 1px 2px rgba(0,0,0,.08)}
.wfm-step[data-need]:hover,.wfm-step[data-need][data-hl],.wfm-step[data-need]:focus-within{box-shadow:0 0 0 1px var(--warning),0 0 0 4px color-mix(in srgb,var(--warning) 22%,transparent)}
.wfm-step[data-bad]{box-shadow:0 0 0 1px var(--error),0 1px 2px rgba(0,0,0,.08)}
.wfm-step[data-flash]{animation:wfm-fl .9s var(--w-ease)}
@keyframes wfm-fl{0%{background:var(--w-wash2)}100%{background:var(--bg)}}
.wfm-sh{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:12px;align-items:center;padding:16px 16px 0}
.wfm-acts{display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.wfm-sb{padding:8px 16px 16px 56px;display:flex;flex-direction:column;gap:12px}
.wfm-pin{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 4px;border-radius:10px;background:var(--text);color:var(--bg);font-size:10px;font-weight:700;font-variant-numeric:tabular-nums;transition:background .12s;border:0}
.wfm-pin[data-lg]{min-width:28px;height:28px;border-radius:14px;font-size:13px}
.wfm-pin[data-off]{background:transparent;color:var(--text3);box-shadow:inset 0 0 0 1px var(--w-edge)}
.wfm-step:hover .wfm-pin:not([data-off]),.wfm-step[data-hl] .wfm-pin:not([data-off]),.wfm-step:focus-within .wfm-pin:not([data-off]),.wfm-pin[data-hl]:not([data-off]){background:var(--primary)}
.wfm-pin[data-off][data-hl]{color:var(--text)}
.wfm-ctl{display:flex;flex-direction:column;border-radius:10px;background:var(--surface-inset);box-shadow:inset 0 0 0 1px var(--w-line)}
.wfm-crow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px}.wfm-crow+.wfm-crow{border-top:var(--w-rule)}
.wfm-lb{display:flex;flex-direction:column;gap:2px;min-width:0}
.wfm-pick{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 0 0 12px;border-radius:8px;border:var(--w-tint);background:var(--bg);color:var(--text);font-size:13px;font-weight:600;box-shadow:0 1px 1px rgba(0,0,0,.08);transition:background .12s,border-color .12s,box-shadow .12s,transform .12s var(--w-ease);cursor:pointer;text-align:left;flex:none;white-space:nowrap}
.wfm-pick .cv{display:grid;place-items:center;align-self:stretch;width:28px;margin-left:4px;border-left:var(--w-rule);color:var(--primary);border-radius:0 7px 7px 0;transition:background .12s}
.wfm-pick:hover{border-color:var(--primary);background:var(--w-wash);box-shadow:0 2px 6px -2px color-mix(in srgb,var(--primary) 45%,transparent)}
.wfm-pick:hover .cv,.wfm-pick[aria-expanded=true] .cv{background:var(--w-wash2)}
.wfm-pick[aria-expanded=true]{border-color:var(--primary);background:var(--w-wash);box-shadow:var(--w-ring)}
.wfm-pick:active{transform:translateY(1px)}
.wfm-pick[data-empty]{border:1px dashed var(--warning);background:var(--w-warn-wash);color:var(--warning-ink)}
.wfm-pick[data-empty] .cv{color:var(--warning-ink);border-color:color-mix(in srgb,var(--warning) 40%,transparent)}
.wfm-pick[data-bad]{border-color:var(--error);background:var(--w-err-wash);color:var(--error-ink)}
.wfm-pick[data-plain]{border-color:var(--w-edge)}.wfm-pick[data-plain] .cv{color:var(--text3)}
.wfm-pick:disabled{opacity:.5;cursor:not-allowed}
.wfm-cov{display:inline-flex;align-items:center;gap:8px;height:24px;padding:0 8px;border-radius:12px;border:0;font-size:11px;font-weight:600;background:var(--w-ok-wash);color:var(--success-ink);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--success) 50%,transparent);transition:filter .12s,box-shadow .12s;cursor:pointer;white-space:nowrap}
.wfm-cov:hover{filter:brightness(.96);box-shadow:inset 0 0 0 1px var(--success-ink)}
.wfm-cov[data-tone=part]{background:var(--w-warn-wash);color:var(--warning-ink);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--warning) 55%,transparent)}
.wfm-cov[data-tone=part]:hover{box-shadow:inset 0 0 0 1px var(--warning-ink)}
.wfm-cov[data-tone=none],.wfm-cov[data-tone=ignored]{background:var(--w-err-wash);color:var(--error-ink);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--error) 50%,transparent)}
.wfm-cov[data-tone=ignored]{background:var(--w-warn-wash);color:var(--warning-ink);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--warning) 55%,transparent)}
.wfm-cov[data-tone=none]:hover{box-shadow:inset 0 0 0 1px var(--error-ink)}
.wfm-cov[data-tone=static]{background:var(--w-ok-wash);cursor:default}.wfm-cov[data-tone=static]:hover{filter:none}
.wfm-segs{display:inline-flex;gap:2px}.wfm-segs i{width:6px;height:10px;border-radius:2px;background:currentColor;opacity:.25}.wfm-segs i[data-y]{opacity:1}
.wfm-cov .cv{display:grid;transition:transform .18s var(--w-ease)}.wfm-cov[aria-expanded=true] .cv{transform:rotate(180deg)}
.wfm-covd{display:flex;flex-direction:column;border-radius:10px;box-shadow:inset 0 0 0 1px var(--w-line);overflow:hidden}
.wfm-covd .r{display:grid;grid-template-columns:140px 16px minmax(0,1fr);gap:8px;align-items:baseline;padding:8px 12px;font-size:11px}
.wfm-covd .r+.r{border-top:var(--w-rule)}.wfm-covd .r[data-y] .s{color:var(--success-ink)}.wfm-covd .r:not([data-y]){background:var(--w-err-wash)}.wfm-covd .r:not([data-y]) .s{color:var(--error-ink)}
.wfm-col{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow:auto;background:var(--bg);border-radius:12px;box-shadow:0 0 0 1px var(--w-edge);padding:16px;display:flex;flex-direction:column;gap:12px}
.wfm-lt{display:flex;flex-direction:column;gap:2px;padding:4px;border-radius:10px;background:var(--surface-inset);box-shadow:inset 0 0 0 1px var(--w-line)}
.wfm-lt button{display:flex;align-items:center;gap:8px;min-height:40px;padding:4px 8px;border:0;border-radius:8px;background:transparent;text-align:left;color:var(--text);cursor:pointer;transition:background .12s}
.wfm-lt button .n{flex:1;display:flex;flex-direction:column;min-width:0;overflow-wrap:anywhere}
.wfm-lt button:hover{background:color-mix(in srgb,var(--bg) 60%,transparent)}
.wfm-lt button[aria-selected=true]{background:var(--bg);box-shadow:0 1px 2px rgba(0,0,0,.2),0 0 0 1px var(--w-line)}
.wfm-lt .again{min-height:0;height:24px;flex:none;font-size:11px;font-weight:600;color:var(--primary-ink);padding:0 8px;border-radius:6px;box-shadow:inset 0 0 0 1px var(--w-edge)}.wfm-lt .again:hover{background:var(--w-wash)}
.wfm-sr{display:flex;align-items:center;gap:8px;min-height:32px;padding:4px 8px;border-radius:8px;border-left:3px solid transparent;transition:background .12s,border-color .12s;font-size:13px}
.wfm-sr .n{flex:1;min-width:0;white-space:normal;overflow-wrap:anywhere}
.wfm-sr[data-tg]{font-weight:700;background:color-mix(in srgb,var(--primary) 6%,var(--bg));border-left-color:var(--text)}
.wfm-sr[data-hl]{background:var(--w-wash2);border-left-color:var(--primary)}
.wfm-pins{display:flex;gap:4px}
.wfm-fold>summary{list-style:none;display:flex;gap:8px;align-items:center;min-height:32px;padding:4px 8px;border-radius:6px;cursor:pointer}
.wfm-fold>summary::-webkit-details-marker{display:none}.wfm-fold>summary:hover{background:var(--w-wash)}
.wfm-fold .chev{transition:transform .18s var(--w-ease);display:grid;color:var(--text3)}.wfm-fold[open]>summary .chev{transform:rotate(90deg)}
.wfm-pop{background:var(--bg);border-radius:10px;box-shadow:0 0 0 1px var(--w-edge),var(--surface-lift);padding:8px;display:flex;flex-direction:column;gap:4px}
.wfm-lst{display:flex;flex-direction:column;gap:2px;max-height:300px;overflow:auto}
.wfm-grp{display:flex;flex-direction:column;gap:2px;padding:4px 0}.wfm-grp+.wfm-grp{border-top:var(--w-rule)}
.wfm-gh{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px;padding:4px 8px}.wfm-gh b{font-size:11px;text-transform:uppercase;letter-spacing:.06em;overflow-wrap:anywhere;min-width:0}
.wfm-opt{display:flex;align-items:center;gap:8px;min-height:32px;padding:4px 8px;border-radius:6px;border:0;background:transparent;text-align:left;width:100%;cursor:pointer;color:var(--text);font-size:13px}
.wfm-opt:hover,.wfm-opt[data-act]{background:var(--w-wash)}.wfm-opt[aria-selected=true]{font-weight:700}
.wfm-opt .n{flex:1;white-space:normal;overflow-wrap:anywhere}.wfm-opt .m{font-size:10px;color:var(--text3)}.wfm-opt .ck{width:16px;color:var(--primary);display:grid}
.wfm-opt .wfm-segs{color:var(--success-ink)}
.wfm-banner{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;border-radius:10px;font-size:13px}
.wfm-banner[data-tone=warn]{background:var(--w-warn-wash);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--warning) 55%,transparent)}
.wfm-banner[data-tone=err]{background:var(--w-err-wash);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--error) 50%,transparent)}
.wfm-mom{display:flex;gap:12px;align-items:flex-start;text-align:left;padding:12px;border-radius:10px;border:var(--w-outline);background:var(--bg);color:var(--text);cursor:pointer;transition:background .12s,border-color .12s,transform .12s var(--w-ease)}
.wfm-mom:hover{border-color:var(--primary);background:var(--w-wash)}.wfm-mom:active{transform:translateY(1px)}
.wfm-mom .gl{width:28px;height:28px;border-radius:8px;background:var(--surface-card);display:grid;place-items:center;color:var(--primary);flex:none}
.wfm-moments{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;width:100%}
.wfm-hlx{background:var(--w-wash2)!important;box-shadow:0 0 0 2px var(--primary)!important;border-radius:6px}
.wfm-ok{color:var(--success-ink)}
@media (prefers-reduced-motion:reduce){.wfm *{transition:none!important;animation:none!important}}
@media (max-width:760px){.wfm-grid{grid-template-columns:minmax(0,1fr)}.wfm-lines{display:none}.wfm-col{position:static;max-height:none}}
`;
