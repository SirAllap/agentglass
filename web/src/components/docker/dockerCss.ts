/*
 * The Containers view's own rules: the grid a row and its column labels share,
 * the nine squares, and the states that need a pseudo-class or a keyframe.
 * Colours are the theme's tokens only, so light and dark both come from
 * index.css; nothing here names a hex.
 */
import { EDGE, LINE } from "../workspace/Chrome.tsx";

export const DOCKER_CSS = `
.dk-g{width:22px;height:22px;display:grid;place-items:center;flex:none}
.dk-g svg{width:16px;height:16px;overflow:visible;display:block}
.dk-spin{animation:dk-rot 1.1s linear infinite;transform-origin:50% 50%}
@keyframes dk-rot{to{transform:rotate(360deg)}}
@keyframes dk-breathe{50%{opacity:.35}}
@keyframes dk-sh{to{background-position:-200% 0}}

.dk-q{width:16px;height:16px;border-radius:4px;display:grid;place-items:center;flex:none;position:relative;padding:0;border:0;background:none}
.dk-q svg{width:10px;height:10px;fill:none;stroke:var(--bg);stroke-width:3;stroke-linecap:round;display:block}
.dk-q[data-t=up]{background:linear-gradient(180deg,color-mix(in srgb,var(--success) 88%,var(--text)),var(--success));box-shadow:inset 0 1px 0 color-mix(in srgb,var(--bg) 25%,transparent)}
.dk-q[data-t=need]{background:linear-gradient(180deg,color-mix(in srgb,var(--error) 90%,var(--bg)),color-mix(in srgb,var(--error) 88%,var(--text)));box-shadow:0 0 0 2px var(--bg),0 0 0 3.5px color-mix(in srgb,var(--error) 45%,transparent)}
.dk-q[data-t=restart]{background:repeating-linear-gradient(135deg,var(--warning) 0 3px,color-mix(in srgb,var(--warning) 80%,var(--text)) 3px 6px);box-shadow:0 0 0 2px var(--bg),0 0 0 3.5px color-mix(in srgb,var(--warning) 45%,transparent)}
.dk-q[data-t=pause]{background:var(--warning);box-shadow:0 0 0 2px var(--bg),0 0 0 3.5px color-mix(in srgb,var(--warning) 45%,transparent)}
.dk-q[data-t=stop]{background:var(--bg);box-shadow:inset 0 0 0 1.5px var(--bg4)}
.dk-q[data-t=made]{background:var(--bg);border:1.5px dashed color-mix(in srgb,var(--info) 60%,transparent)}
.dk-q[data-current=true]{outline:2px solid var(--text);outline-offset:2px}
.dk-q[data-small=true]{width:11px;height:11px;border-radius:3px}
.dk-q[data-small=true] svg{display:none}
.dk-q[data-dim=true]{opacity:.25}
button.dk-q{cursor:pointer;transition:transform 140ms var(--ease-out,ease)}
button.dk-q:hover{transform:scale(1.15)}

.dk-cols{display:grid;grid-template-columns:22px minmax(0,1fr) 96px 104px 132px 28px 28px;gap:10px;align-items:center;padding:0 10px}
.dk-ch{height:24px;font-size:9.5px;line-height:1;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;border-bottom:${LINE};background:color-mix(in srgb,var(--bg2) 35%,var(--bg))}
.dk-r{min-height:46px;border-bottom:${LINE};cursor:pointer;position:relative;transition:background .12s;padding-block:4px;outline:none}
.dk-r:last-child{border-bottom:0}
.dk-r:hover{background:color-mix(in srgb,var(--text) 3%,transparent)}
.dk-r:focus-visible{box-shadow:inset 0 0 0 2px var(--primary)}
.dk-r[data-sel=true]{background:color-mix(in srgb,var(--primary) 7%,var(--bg))}
.dk-r[data-sel=true]::before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:3px;border-radius:0 2px 2px 0;background:var(--primary)}
.dk-r[data-need=true]{background:color-mix(in srgb,var(--error) 4%,var(--bg))}
.dk-r[data-need=true][data-sel=true]{background:color-mix(in srgb,var(--primary) 8%,color-mix(in srgb,var(--error) 4%,var(--bg)))}
.dk-r[data-dense=true]{min-height:32px;padding-block:1px}
.dk-r[data-off=true] .dk-nm{color:var(--text3)}
.dk-nm{display:flex;align-items:center;gap:6px;font-size:12.5px;line-height:1.25;font-weight:500;color:var(--text);white-space:nowrap;min-width:0}
.dk-nm>span:first-child{overflow:hidden;text-overflow:ellipsis;min-width:0}
.dk-sb{display:block;font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;line-height:1.35;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dk-sb [data-tone=warn]{color:var(--error-ink,var(--error))}
.dk-sb [data-tone=amb]{color:var(--warning-ink,var(--warning))}

.dk-m{display:flex;flex-direction:column;gap:4px;font-size:11px;line-height:1;color:var(--text2);min-width:0;font-variant-numeric:tabular-nums}
.dk-m .v{display:flex;justify-content:space-between;gap:6px;white-space:nowrap}
.dk-m .v small{color:var(--text4);font-size:10px;overflow:hidden;text-overflow:ellipsis}
.dk-m .bar{height:4px;border-radius:3px;background:var(--bg3);overflow:hidden}
.dk-m .bar i{display:block;height:100%;border-radius:3px;background:color-mix(in srgb,var(--text) 55%,var(--bg3))}
.dk-m[data-hot=true] .v b{color:var(--warning-ink,var(--warning));font-weight:700}
.dk-m[data-hot=true] .bar i{background:var(--warning)}
.dk-m[data-none=true]{color:var(--text4)}
.dk-m[data-none=true] .bar{background:none;border:1px dashed var(--bg4)}

.dk-port{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:7px;font-size:11px;line-height:1;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;border:0;background:transparent;min-width:0;font-family:var(--font-mono,ui-monospace,monospace)}
.dk-port[data-port=web]{color:var(--info-ink,var(--info));background:color-mix(in srgb,var(--info) 6%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--info) 24%,transparent);cursor:pointer;transition:transform 140ms var(--ease-out,ease),background .12s}
.dk-port[data-port=web]:hover{background:color-mix(in srgb,var(--info) 12%,var(--bg))}
.dk-port[data-port=web]:active{transform:scale(.97)}
.dk-port[data-port=plain]{color:var(--text2);padding:0 2px}
.dk-port[data-port=off],.dk-port[data-port=none]{color:var(--text4);padding:0 2px}

.dk-confirm{display:flex;align-items:center;gap:10px;padding:6px 14px;font-size:11.5px;border-top:1px solid color-mix(in srgb,var(--warning) 30%,transparent);background:color-mix(in srgb,var(--warning) 9%,var(--bg))}
.dk-confirm[data-danger=true]{border-top-color:color-mix(in srgb,var(--error) 25%,transparent);background:color-mix(in srgb,var(--error) 8%,var(--bg))}
.dk-confirm>span{flex:1;min-width:0}

.dk-stack{border:${EDGE};border-radius:12px;background:var(--bg);box-shadow:0 1px 2px color-mix(in srgb,var(--text) 5%,transparent);margin-bottom:10px;overflow:clip;flex:none}
.dk-sh{display:grid;grid-template-columns:26px minmax(0,1fr) auto auto 28px;align-items:center;gap:8px;height:42px;padding:0 8px 0 6px;background:linear-gradient(180deg,var(--bg),color-mix(in srgb,var(--bg2) 50%,var(--bg)));border-bottom:${LINE}}
.dk-stack[data-folded=true] .dk-sh{border-bottom:0}
.dk-tg{width:26px;height:26px;border:0;border-radius:6px;background:transparent;display:grid;place-items:center;color:var(--text3);transition:transform .15s var(--ease-out,ease)}
.dk-tg:hover{background:var(--surface-inset)}
.dk-stack[data-folded=true] .dk-tg{transform:rotate(-90deg)}
.dk-own{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 7px;border-radius:6px;font-size:11px;line-height:1;font-family:var(--font-mono,ui-monospace,monospace);color:var(--text2);background:var(--bg);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text) 12%,transparent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto;max-width:55%}
.dk-own[data-foreign=true]{color:var(--merged-ink,var(--warning-ink));background:color-mix(in srgb,var(--merged,var(--warning)) 8%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--merged,var(--warning)) 30%,transparent)}
.dk-tally{font-size:11px;font-family:var(--font-mono,ui-monospace,monospace);color:var(--text3);white-space:nowrap}
.dk-tally b{color:var(--error-ink,var(--error));font-weight:600}
.dk-more{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;color:var(--text3);border:1px solid transparent;background:transparent;padding:0}
.dk-r:hover .dk-more,.dk-r[data-sel=true] .dk-more,.dk-more[data-open=true]{color:var(--text2)}
.dk-more:hover,.dk-more[data-open=true]{background:var(--surface-inset);border-color:var(--border)}
.dk-more:disabled{opacity:.4;cursor:not-allowed}

.dk-say{font-size:13px;line-height:1.45;color:var(--text2);margin:0 0 12px}
.dk-say b{color:var(--text);font-weight:600}
.dk-answers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:14px}
.dk-ans{position:relative;display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;padding:11px 12px 10px;border-radius:12px;border:${EDGE};background:linear-gradient(180deg,var(--bg),color-mix(in srgb,var(--bg2) 55%,var(--bg)));cursor:pointer;transition:border-color .15s,box-shadow .15s,transform 140ms var(--ease-out,ease);min-width:0;text-align:left;font:inherit;color:inherit;align-items:start}
.dk-ans:hover:not(:disabled){border-color:color-mix(in srgb,var(--tone) 45%,transparent)}
.dk-ans:active:not(:disabled){transform:scale(.99)}
.dk-ans[aria-pressed=true]{border-color:color-mix(in srgb,var(--tone) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--tone) 12%,transparent)}
.dk-ans:disabled{cursor:default;opacity:.7}
.dk-tile{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;color:var(--tone);background:linear-gradient(180deg,var(--bg),color-mix(in srgb,var(--tone) 9%,var(--bg)));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tone) 24%,transparent),inset 0 1px 0 var(--bg),0 1px 2px rgba(0,0,0,.07);flex:none}
.dk-ans .n{font-size:20px;line-height:1;color:var(--text);letter-spacing:-.01em;font-weight:600}
.dk-ans .w{font-size:12.5px;line-height:1.2;color:var(--text);margin-left:6px;font-weight:600}
.dk-ans .d{font-size:11.5px;line-height:1.35;color:var(--text3);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dk-ans .now{font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;line-height:1.3;color:var(--text3);margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dk-ans .now b{color:var(--text2);font-weight:500}
.dk-fmap{display:flex;flex-wrap:wrap;gap:8px 18px;padding:10px 12px;border-radius:10px;background:linear-gradient(180deg,color-mix(in srgb,var(--bg2) 70%,var(--bg)),var(--bg2));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text) 7%,transparent);margin-bottom:16px}
.dk-mg{display:flex;flex-direction:column;gap:7px;min-width:0}
.dk-mg .l{font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;line-height:1;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px}
.dk-mg .sq{display:flex;flex-wrap:wrap;gap:4px;max-width:260px;padding:2px}

.dk-lh{display:flex;align-items:center;gap:6px;height:30px;padding:0 10px;font-size:11px;font-weight:600;color:var(--text3);border-bottom:${LINE};background:color-mix(in srgb,var(--bg2) 50%,var(--bg));position:sticky;top:0;z-index:1}
.dk-lh .dk-mini{margin-left:auto}
.dk-lh .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dk-mini{display:flex;gap:3px;align-items:center;flex:none}
.dk-lr{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:8px;align-items:center;height:36px;padding:0 10px;border-bottom:${LINE};cursor:pointer;position:relative;outline:none}
.dk-lr:hover{background:color-mix(in srgb,var(--text) 3%,transparent)}
.dk-lr:focus-visible{box-shadow:inset 0 0 0 2px var(--primary)}
.dk-lr[data-sel=true]{background:var(--bg);box-shadow:inset 3px 0 0 var(--primary),inset 0 -1px 0 color-mix(in srgb,var(--text) 8%,transparent)}
.dk-lr .nm{font-size:12.5px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dk-lr[data-off=true] .nm{color:var(--text3)}
.dk-lr .rt{font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;color:var(--text3);white-space:nowrap}
.dk-lr .rt[data-hot=true]{color:var(--warning-ink,var(--warning));font-weight:600}
.dk-fbar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:${LINE};font-size:11px;color:var(--text3)}

.dk-shim i{display:block;height:10px;border-radius:5px;background:linear-gradient(90deg,var(--bg3),var(--bg2),var(--bg3));background-size:200% 100%;animation:dk-sh 1.4s linear infinite}
.dk-banner{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 10px;border-radius:9px;font-size:12px;line-height:1.4;margin-bottom:12px;background:color-mix(in srgb,var(--warning) 8%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--warning) 28%,transparent);color:var(--warning-ink,var(--text2))}
.dk-banner svg{color:var(--warning)}
.dk-banner b{font-weight:600}
.dk-dimmed{opacity:.5;pointer-events:none;user-select:none}
.dk-empty-s{padding:26px 14px;font-size:11.5px;color:var(--text3);text-align:center}
.dk-full{flex:1;display:grid;place-items:center;padding:24px;text-align:center}
.dk-card{max-width:470px;background:var(--bg);border:${EDGE};border-radius:14px;box-shadow:var(--surface-lift);padding:20px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px}
.dk-card .ico{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;background:color-mix(in srgb,var(--tint) 12%,var(--bg));color:var(--tint)}
.dk-card b{font-size:14px}
.dk-card p{margin:0;color:var(--text2);font-size:11.5px;line-height:1.55}
.dk-card .row{display:flex;gap:6px;flex-wrap:wrap;justify-content:center}

.dk-fresh{font-size:11px;color:var(--text3);display:inline-flex;gap:5px;align-items:center;white-space:nowrap}
.dk-fresh[data-warn=true]{color:var(--warning-ink,var(--warning))}
.dk-live{width:7px;height:7px;border-radius:50%;background:var(--success);box-shadow:0 0 0 3px color-mix(in srgb,var(--success) 18%,transparent)}
.dk-fresh[data-warn=true] .dk-live{background:var(--warning);box-shadow:0 0 0 3px color-mix(in srgb,var(--warning) 20%,transparent);animation:dk-breathe 1.8s ease-in-out infinite}
.dk-scope{height:28px;display:inline-flex;align-items:center;gap:6px;padding:0 9px;border-radius:8px;font-size:11px;color:var(--text2);background:var(--surface-inset);box-shadow:inset 0 0 0 1px var(--surface-line);white-space:nowrap;min-width:0;overflow:hidden}
.dk-scope b{font-weight:600;color:var(--text)}
.dk-scope[data-all=true]{color:var(--warning-ink,var(--warning));background:color-mix(in srgb,var(--warning) 9%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--warning) 32%,transparent)}
.dk-scope[data-all=true] b{color:inherit}
.dk-ro{height:28px;display:inline-flex;align-items:center;gap:5px;padding:0 9px;border-radius:8px;font-size:11px;color:var(--text3);box-shadow:inset 0 0 0 1px var(--surface-line)}

.dk-nav{width:196px;flex:none;border-right:${LINE};background:var(--surface-nav,var(--bg2));padding:10px 8px;display:flex;flex-direction:column;gap:2px;overflow:auto}
.dk-nvh{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--text3);font-weight:600;margin:10px 9px 4px}
.dk-nv{display:flex;align-items:center;gap:9px;height:34px;padding:0 9px;border:0;border-radius:8px;background:transparent;text-align:left;font-size:12px;color:var(--text2);position:relative;width:100%}
.dk-nv:hover{background:var(--surface-inset)}
.dk-nv[aria-current=page]{background:var(--bg);color:var(--text);box-shadow:0 1px 2px color-mix(in srgb,var(--text) 8%,transparent),inset 0 0 0 1px color-mix(in srgb,var(--text) 12%,transparent)}
.dk-nv[aria-current=page]::before{content:"";position:absolute;left:-8px;top:9px;bottom:9px;width:3px;border-radius:2px;background:var(--primary)}
.dk-nv .n{margin-left:auto;font-size:10.5px;color:var(--text3)}
.dk-nv .n .amb{color:var(--warning-ink,var(--warning));font-weight:600}
.dk-nv .n .amb b{font-weight:700}
.dk-sub{margin:auto 0 0;padding:10px 9px 2px;font-size:10.5px;color:var(--text3);line-height:1.45;border-top:${LINE}}
.dk-sub kbd{font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;color:var(--text3);background:var(--surface-inset);border-radius:4px;padding:1px 5px;box-shadow:inset 0 0 0 1px var(--surface-line)}

.dk-mi{display:flex;width:100%;align-items:center;gap:8px;height:28px;padding:0 8px;border:0;background:transparent;border-radius:6px;text-align:left;font-size:11.5px;color:var(--text);flex:none;white-space:nowrap}
.dk-mi:hover:not(:disabled),.dk-mi:focus-visible{background:var(--surface-inset);outline:none}
.dk-mi:disabled{color:var(--text4);cursor:not-allowed;background:transparent}
.dk-mi[data-danger=true]:not(:disabled){color:var(--error-ink,var(--error))}
.dk-mi .r{margin-left:auto;color:var(--text3);font-size:10.5px}
.dk-hr{height:1px;background:var(--surface-line);margin:5px 4px;flex:none}

.dk-head{border-bottom:${LINE};flex:none;min-width:0}
.dk-dhd{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:12px;align-items:start;padding:14px 16px 12px;min-width:0}
.dk-dhd .t1{font-size:15px;line-height:1.3;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px;min-width:0;height:22px}
.dk-dhd .t1>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dk-dhd .t2{font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;line-height:1.4;color:var(--text3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dk-dhd .acts{display:flex;gap:6px;align-items:center}
.dk-step{display:inline-flex;align-items:center;gap:2px;margin-right:6px;font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;color:var(--text3);font-variant-numeric:tabular-nums}
.dk-step span{min-width:44px;text-align:center}

.dk-why{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:8px;align-items:center;margin:-2px 16px 12px;padding:8px 10px;border-radius:9px;background:color-mix(in srgb,var(--error) 6%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--error) 22%,transparent);font-size:12px;line-height:1.4;color:var(--error-ink,var(--error))}
.dk-why svg{color:var(--error)}
.dk-why b{font-weight:600}
.dk-why code{background:var(--bg);color:inherit;font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;padding:1px 4px;border-radius:4px}
.dk-why[data-tone=amb]{background:color-mix(in srgb,var(--warning) 7%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--warning) 28%,transparent);color:var(--warning-ink,var(--warning))}
.dk-why[data-tone=amb] svg{color:var(--warning)}
.dk-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:0 16px 12px}
.dk-fact{padding:8px 10px;border-radius:10px;background:linear-gradient(180deg,color-mix(in srgb,var(--bg2) 60%,var(--bg)),var(--bg2));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text) 7%,transparent);min-width:0}
.dk-fact .k{font-size:10px;line-height:1;font-weight:600;color:var(--text3);letter-spacing:.02em}
.dk-fact .v{font-size:15px;line-height:1.2;font-weight:600;color:var(--text);margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dk-fact .v small{font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;font-weight:500;color:var(--text3)}
.dk-fact[data-hot=true] .v{color:var(--warning-ink,var(--warning))}
.dk-fact .dk-m{margin-top:6px}
.dk-fact .pls{display:flex;gap:6px;margin-top:3px;flex-wrap:nowrap;overflow:hidden}

.dk-lt{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none;min-height:44px;padding:7px 12px;border-bottom:${LINE}}
.dk-lt .fld{position:relative;flex:1 1 140px;max-width:200px;min-width:0}
.dk-lt .fld svg{position:absolute;left:9px;top:50%;margin-top:-7px;color:var(--text3);pointer-events:none}
.dk-lt .cnt{font-size:10.5px;color:var(--text3);white-space:nowrap;font-variant-numeric:tabular-nums}
.dk-lt .sp{flex:1}
.dk-st{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;font-size:11px;color:var(--text2);background:var(--surface-inset);white-space:nowrap}
.dk-st i{width:7px;height:7px;border-radius:50%;background:var(--success);animation:dk-breathe 1.6s ease-in-out infinite}
.dk-st[data-k=ended] i{background:var(--text4);animation:none}
.dk-st[data-k=snapshot] i{background:var(--primary);animation:none}
.dk-st[data-k=paused] i{background:var(--warning);animation:none}
.dk-cn{font-weight:600;color:var(--text3);margin-left:4px;font-variant-numeric:tabular-nums}
.dk-cn[data-l=error]{color:var(--error-ink,var(--error))}
.dk-cn[data-l=warn]{color:var(--warning-ink,var(--warning))}

.dk-logwrap{flex:1;min-height:120px;position:relative;display:flex;flex-direction:column;min-width:0}
.dk-log{flex:1;overflow:auto;margin:0;padding:10px 14px;font-family:var(--font-mono,ui-monospace,monospace);font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--text);background:var(--bg)}
.dk-log .ln{display:block}
.dk-log .ts{color:var(--text4);margin-right:8px}
.dk-log .ln[data-lv=error]{background:color-mix(in srgb,var(--error) 6%,transparent);color:var(--error-ink,var(--error))}
.dk-log .ln[data-lv=warn][data-tag=true]{color:var(--warning-ink,var(--warning))}
.dk-log .ln[data-flash=true]{animation:dk-flash 1.8s ease-out}
.dk-log mark{background:color-mix(in srgb,var(--warning) 35%,transparent);color:inherit;border-radius:2px}
.dk-log mark[data-cur=true]{background:color-mix(in srgb,var(--warning) 75%,transparent)}
.dk-log .dim{color:var(--text3)}
@keyframes dk-flash{from{background:color-mix(in srgb,var(--error) 30%,transparent)}}
.dk-jump{position:absolute;left:50%;bottom:12px;transform:translateX(-50%)}
.dk-logend{padding:8px 14px;font-size:11px;color:var(--text3);border-top:1px dashed var(--surface-line);flex:none}

.dk-folds{overflow:auto;flex:none;max-height:46%}
.dk-acc{border-top:${LINE};flex:none}
.dk-acc>button{width:100%;display:flex;align-items:center;gap:8px;height:34px;padding:0 14px;border:0;background:transparent;text-align:left;font-size:11.5px;color:var(--text2)}
.dk-acc>button:hover{background:var(--surface-inset)}
.dk-acc>button>svg{transition:transform .15s var(--ease-out,ease);color:var(--text3);transform:rotate(0deg)}
.dk-acc[data-open=false]>button>svg{transform:rotate(-90deg)}
.dk-acc>button .n{margin-left:auto;font-size:10.5px;color:var(--text3)}
.dk-acc .ab{max-height:34vh;overflow:auto;padding:4px 14px 12px;display:flex;flex-direction:column;gap:6px}
.dk-kv{display:grid;grid-template-columns:minmax(120px,38%) 1fr;gap:3px 10px;font-size:11px}
.dk-kv .k{color:var(--text3);overflow:hidden;text-overflow:ellipsis}
.dk-kv .v{color:var(--text);overflow:hidden;text-overflow:ellipsis;font-family:var(--font-mono,ui-monospace,monospace)}
.dk-kv .v[data-mask=true]{color:var(--text4)}
.dk-lk{border:0;background:none;padding:0;font:inherit;color:var(--text3);cursor:pointer}
.dk-lk u{color:var(--info)}
.dk-dfr{display:grid;grid-template-columns:22px minmax(110px,32%) 1fr 1fr;gap:3px 8px;font-size:11px;align-items:center}
.dk-dfr .sg{font-weight:700;text-align:center;color:var(--warning)}
.dk-dfr .sg[data-c=same]{color:var(--text4)}
.dk-dfr .sg[data-c=only-a]{color:var(--info)}
.dk-dfr .sg[data-c=only-b]{color:var(--merged,var(--info))}
.dk-dfr .mono{font-family:var(--font-mono,ui-monospace,monospace);overflow-wrap:anywhere}
.dk-tbl{width:100%;border-collapse:collapse;font-size:11.5px}
.dk-tbl th{text-align:left;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--text3);font-weight:600;padding:0 10px;height:26px;border-bottom:${LINE};white-space:nowrap}
.dk-tbl td{padding:0 10px;height:28px;border-bottom:${LINE};white-space:nowrap;font-family:var(--font-mono,ui-monospace,monospace)}
.dk-tbl .r{text-align:right}
.dk-json{margin:0;font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all;color:var(--text2)}
.dk-mut{font-size:11px;color:var(--text3)}

@media (prefers-reduced-motion:reduce){.dk-spin,.dk-shim i,.dk-fresh[data-warn=true] .dk-live,.dk-st i,.dk-log .ln[data-flash=true]{animation:none}}

/* Mockup base: 12px / 1.4 under everything; the app's body is 16px, which put 3px into every card line box. */
.dk-root{font-size:12px;line-height:1.4}
.dk-hdr .agx-seg-b{font-size:11px;padding:0 10px}
.dk-badge{display:inline-flex;align-items:center;gap:4px;height:16px;padding:0 6px;border-radius:5px;font-size:10px;line-height:1;white-space:nowrap;flex:none;color:var(--tint,var(--text3));background:color-mix(in srgb,var(--tint,var(--text3)) 11%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tint,var(--text3)) 28%,transparent)}
.dk-badge svg{color:inherit}
.dk-act{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;border:${EDGE};background:linear-gradient(180deg,var(--bg),var(--bg2));color:var(--tone,var(--text2));box-shadow:0 1px 1px rgba(0,0,0,.04);padding:0;flex:none;cursor:pointer;transition:transform 140ms var(--ease-out,ease),border-color .12s,background .12s}
.dk-act:hover:not(:disabled){border-color:color-mix(in srgb,var(--tone,var(--text)) 45%,transparent);background:color-mix(in srgb,var(--tone,var(--text)) 6%,var(--bg))}
.dk-act:active:not(:disabled){transform:scale(.94)}
.dk-act:disabled{opacity:.4;cursor:default;box-shadow:none}
.dk-chip{height:28px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;border-radius:8px;border:${EDGE};background:var(--surface-inset);color:var(--text2);font-size:11px;white-space:nowrap;line-height:1;flex:none;cursor:pointer;transition:background .12s,transform 140ms var(--ease-out,ease)}
.dk-chip:hover:not(:disabled){background:var(--bg3)}
.dk-chip:active:not(:disabled){transform:scale(.97)}
.dk-chip:disabled{opacity:.45;cursor:default}
.dk-chip.sq{width:28px;padding:0;justify-content:center}
.dk-chip svg{flex:none}
.dk-chip[data-tone] svg{color:var(--tone)}
.dk-chip.sm{height:22px;font-size:10.5px;padding:0 8px;gap:5px}
.dk-chip.ghost{background:transparent;border-color:transparent}
.dk-chip.ghost:hover:not(:disabled){background:var(--surface-inset)}
.dk-dock{flex:none;display:flex;align-items:center;gap:8px;height:34px;padding:0 10px 0 14px;font-size:11.5px;color:var(--text2);border-top:${LINE};background:var(--surface-nav)}
.dk-dock .mut{font-size:10.5px;color:var(--text3)}
.dk-dock .cr{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;color:var(--text3)}
`;
