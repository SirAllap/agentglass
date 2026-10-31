/*
 * The Machine dialog's rules: the frame, the port rows, the detail pane, the
 * dials, the disk plan, the process tree and the pinned Disk footer. Theme
 * tokens only, so light and dark both come from index.css. Nothing is capped in
 * width: the Ports detail pane takes clamp(400px, 30%, 760px), the mount bars
 * auto-fit from 380px, and Resources goes to two columns from 1300px.
 */
import { EDGE, LINE } from "../workspace/Chrome.tsx";

const MONO = "var(--font-mono,ui-monospace,monospace)";

export const MACHINE_CSS = `
.mc-mod{position:fixed;z-index:2;top:5vh;bottom:5vh;left:1%;right:1%;display:flex;flex-direction:column;overflow:hidden;background:var(--bg);border:${EDGE};border-radius:14px;box-shadow:0 40px 90px -24px var(--shadow)}
.mc-h{flex:none;padding:12px 14px 0 16px;border-bottom:${LINE};background:var(--bg)}
.mc-r1{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.mc-r1 b{font-size:15px;font-weight:600;color:var(--text)}
.mc-r1 span{font-size:11.5px;color:var(--text3);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mc-tabn{font-family:${MONO};font-size:10.5px;color:var(--text4);margin-left:6px;font-weight:400}
.mc-low{border-radius:9px;padding:0 6px;margin-left:6px;font-size:9.5px;line-height:16px;font-weight:400;color:var(--warning-ink,var(--warning));background:color-mix(in srgb,var(--warning) 16%,transparent)}
.mc-b{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--bg)}
.mc-body{flex:1;min-height:0;display:flex}
.mc-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.mc-pad{padding:18px;flex:1;min-width:0;overflow:auto;font-size:11.5px;color:var(--text3)}
.mc-pad[data-err=true]{color:var(--error-ink,var(--error))}
.mc-scr{overflow:auto;min-height:0}
.mc-tool{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:${LINE}}
.mc-fld{flex:1;min-width:0;max-width:380px}
.mc-fld input{width:100%}
.mc-foot{flex:none;display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:${LINE};background:linear-gradient(180deg,color-mix(in srgb,var(--bg2) 45%,var(--bg)),color-mix(in srgb,var(--bg2) 70%,var(--bg)))}
.mc-foot .why{font-size:11.5px;line-height:1.35;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.mc-foot .why b{color:var(--text2)}
.mc-spin{display:inline-flex;animation:mc-rot .8s linear infinite}
@keyframes mc-rot{to{transform:rotate(360deg)}}
.mc-ind{height:3px;border-radius:2px;background:var(--bg3);margin:8px 0;overflow:hidden;position:relative}
.mc-ind i{position:absolute;inset:0;width:30%;background:var(--info);border-radius:2px;animation:mc-ind 1.1s ease-in-out infinite}
@keyframes mc-ind{from{left:-30%}to{left:100%}}
@media (prefers-reduced-motion:reduce){.mc-mod *{transition:none!important;animation:none!important}}

.mc-gh{display:flex;align-items:center;gap:10px;padding:0 14px;height:28px;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--text3);font-weight:600;width:100%;border:0;background:transparent;text-align:left}
.mc-gh .n{margin-left:auto;font-weight:500}
.mc-gh .hint{font-weight:400;text-transform:none;letter-spacing:0;color:var(--text4)}
.mc-gh .lead{display:inline-flex;gap:6px;align-items:center}
button.mc-gh:hover{background:var(--surface-inset)}
button.mc-gh svg{transition:transform .15s var(--ease-out,ease)}
button.mc-gh[aria-expanded=false] svg{transform:rotate(-90deg)}
.mc-empty{padding:26px 14px;font-size:11.5px;color:var(--text3);text-align:center}
.mc-note{margin:8px 14px 0;padding:8px 10px;border-radius:8px;font-size:11.5px;display:flex;gap:8px;align-items:center;color:var(--text2);background:color-mix(in srgb,var(--tint,var(--text3)) 8%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tint,var(--text3)) 25%,transparent)}
.mc-note svg{color:var(--tint);flex:none}
.mc-note .x{margin-left:auto}

.mc-prow{display:grid;grid-template-columns:14px 58px minmax(240px,1fr) minmax(0,auto) 130px 112px;gap:10px;align-items:center;min-height:46px;padding:4px 14px;border-top:${LINE};position:relative;cursor:pointer}
.mc-prow:hover{background:var(--surface-inset)}
.mc-prow[data-sel=true]{background:color-mix(in srgb,var(--primary) 8%,var(--bg))}
.mc-prow[data-sel=true]::before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:3px;border-radius:0 2px 2px 0;background:var(--primary)}
.mc-prow[data-ext=true]{min-height:36px;opacity:.75;cursor:default}
.mc-prow .dot{width:7px;height:7px;border-radius:50%;background:var(--success);justify-self:center}
.mc-prow[data-ext=true] .dot{background:var(--bg4)}
.mc-prow .pn{font-size:14px;color:var(--info);font-weight:600;font-variant-numeric:tabular-nums}
.mc-prow[data-ext=true] .pn{color:var(--text3);font-weight:400}
.mc-prow .pm{display:flex;flex-direction:column;min-width:0}
.mc-prow .pp{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.mc-prow[data-ext=true] .pp{font-weight:400;color:var(--text2)}
.mc-prow .pp small{font-weight:400;color:var(--text3);font-size:10.5px}
.mc-prow .pd2{font-size:10.5px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-prow .pf{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;min-width:0}
.mc-prow .pc{display:flex;justify-content:flex-end;min-width:0;overflow:hidden}
.mc-prow .pa{display:flex;gap:2px;justify-content:flex-end;opacity:0;transition:opacity .12s}
.mc-prow:hover .pa,.mc-prow[data-sel=true] .pa,.mc-prow:focus-within .pa,.mc-prow .pa[data-armed=true]{opacity:1}
.mc-tag{display:inline-flex;align-items:center;gap:4px;height:16px;padding:0 6px;border-radius:5px;font-size:10px;line-height:1;white-space:nowrap;flex:none;color:var(--tint,var(--text3));background:color-mix(in srgb,var(--tint,var(--text3)) 11%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tint,var(--text3)) 28%,transparent)}
.mc-tag[data-co=true]{max-width:100%;overflow:hidden;text-overflow:ellipsis;display:inline-block;line-height:16px}

.mc-dp{width:clamp(400px,30%,760px);flex:none;border-left:${LINE};display:flex;flex-direction:column;background:var(--surface-nav);min-height:0}
.mc-dph{display:flex;gap:8px;align-items:center;padding:8px 10px 8px 14px;border-bottom:${LINE};font-size:13px;color:var(--text)}
.mc-dph .pid{font-size:10.5px;color:var(--text4);font-variant-numeric:tabular-nums}
.mc-dph .x{margin-left:auto}
.mc-dpb{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px;font-size:11.5px;color:var(--text2)}
.mc-dpf small{display:block;font-size:9.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--text3);font-weight:600;margin-bottom:3px}
.mc-dpf .sel{user-select:text;word-break:break-all}
.mc-dpf .anc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-dpf .anc i{font-style:normal;color:var(--text4)}
.mc-kv{display:grid;grid-template-columns:minmax(90px,40%) 1fr;gap:3px 10px;font-size:11px}
.mc-kv .k{color:var(--text3);overflow:hidden;text-overflow:ellipsis}
.mc-kv .v{color:var(--text);user-select:text;word-break:break-all}
.mc-kv .v button{border:0;background:transparent;padding:0;font:inherit;color:var(--text3);cursor:pointer}
.mc-kv .v button u{color:var(--primary-ink,var(--primary))}
.mc-dpb .warn{color:var(--warning-ink,var(--warning))}

.mc-ours{display:flex;gap:10px;align-items:baseline;margin-left:auto;min-width:0}
.mc-ours b{font-size:18px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums}
.mc-ours b small{font-size:11px;font-weight:400;color:var(--text3)}
.mc-ours>span{font-size:11px;color:var(--text3);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mc-res{flex:1;padding:10px 14px 14px;display:flex;flex-direction:column;gap:12px}
.mc-gauges{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:8px}
.mc-gz{padding:10px;border-radius:10px;background:linear-gradient(180deg,color-mix(in srgb,var(--bg2) 60%,var(--bg)),var(--bg2));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text) 7%,transparent);display:grid;grid-template-columns:40px minmax(0,1fr);gap:9px;align-items:center;min-width:0}
.mc-gz svg{width:40px;height:40px}
.mc-gz .k{font-size:10px;font-weight:600;color:var(--text3);letter-spacing:.02em}
.mc-gz .v{font-size:14px;line-height:1.15;font-weight:600;color:var(--text);white-space:nowrap}
.mc-gz .s{font:10.5px ${MONO};color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-gz[data-hot=true] .v{color:var(--warning-ink,var(--warning))}
.mc-rcols{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start}
.mc-rcol{display:flex;flex-direction:column;gap:12px;min-width:0}
@media (min-width:1300px){.mc-rcols{grid-template-columns:minmax(0,1fr) minmax(0,1.1fr)}}

.mc-lbr{display:grid;grid-template-columns:minmax(0,1fr) 56px 56px auto;gap:10px;align-items:center;padding:6px 8px;border-radius:8px;border:${EDGE}}
.mc-lbr+.mc-lbr{margin-top:4px}
.mc-lbr .lm{display:flex;flex-direction:column;min-width:0}
.mc-lbr .lm b{font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mc-lbr .lm small{font-size:10px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mc-lbr .lb-btns{display:flex;gap:4px;justify-content:flex-end}
.mc-r{text-align:right;font-size:11px;color:var(--text3);font-variant-numeric:tabular-nums}
.mc-r.hot{color:var(--warning-ink,var(--warning))}
.mc-fine{font-size:10.5px;color:var(--text3)}

.mc-sect{display:flex;align-items:center;gap:8px;min-height:28px}
.mc-sect svg{color:var(--text3)}
.mc-sect b{font-size:13px;font-weight:600;color:var(--text)}
.mc-sect .t{font-size:12px;color:var(--text3);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mc-sect .sp{flex:1}
.mc-dc{display:flex;flex-direction:column;gap:10px}
.mc-mounts{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:8px}
.mc-mount{padding:9px 10px;border-radius:10px;border:${EDGE};min-width:0}
.mc-mount .a{display:flex;justify-content:space-between;gap:8px;font:11px ${MONO};color:var(--text2);white-space:nowrap}
.mc-mount .a b{font-weight:600;color:var(--text)}
.mc-mount .a span{color:var(--text3);overflow:hidden;text-overflow:ellipsis}
.mc-mount .a em{font-style:normal;color:var(--success-ink,var(--success))}
.mc-mount .a span[data-low=true]{color:var(--warning-ink,var(--warning))}
.mc-mount .b{display:flex;height:8px;border-radius:5px;background:var(--bg3);overflow:hidden;margin-top:7px}
.mc-mount .b i{display:block;height:100%}
.mc-mount .b i[data-stripe=safe]{background-image:repeating-linear-gradient(135deg,var(--success) 0 3px,color-mix(in srgb,var(--success) 45%,var(--bg)) 3px 6px)}
.mc-vgrp{border:${EDGE};border-radius:12px;overflow:hidden;background:var(--bg)}
.mc-vh{display:grid;grid-template-columns:22px minmax(0,1fr) auto auto;gap:8px;align-items:center;min-height:42px;padding:0 8px 0 10px;background:linear-gradient(180deg,var(--bg),color-mix(in srgb,var(--bg2) 50%,var(--bg)));border-bottom:${LINE}}
.mc-vgrp[data-fold=true] .mc-vh{border-bottom:0}
.mc-vh>span:first-child{display:inline-grid}
.mc-vh b{font-size:12.5px;font-weight:600;color:var(--text)}
.mc-vh small{font-size:11px;color:var(--text3);margin-left:6px;font-weight:400}
.mc-vh .sz{font:600 12px ${MONO};color:var(--text2);min-width:62px;text-align:right}
.mc-vh .sl{display:flex;gap:6px;justify-content:flex-end;min-width:96px}
.mc-vr{display:grid;grid-template-columns:minmax(0,1fr) 84px 36px;gap:10px;align-items:center;min-height:40px;padding:0 10px 0 40px;border-bottom:${LINE}}
.mc-vr:last-child{border-bottom:0}
.mc-vr[data-arm=true],.mc-vr[data-staged=true]{grid-template-columns:minmax(0,1fr) 84px auto}
.mc-vr[data-staged=true]{box-shadow:inset 2px 0 0 var(--primary)}
.mc-vr .a{font-size:12.5px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-vr .a small{display:block;font-size:11px;color:var(--text3);font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-vr .a i{font-style:normal;font-size:9.5px;color:var(--text4);margin-left:6px}
.mc-vr .a i[data-staged=true]{color:var(--primary-ink,var(--primary))}
.mc-vr .s{font:12px ${MONO};color:var(--text2);text-align:right}
.mc-vr .s.root{color:var(--text4)}
.mc-vr .sl{display:flex;gap:6px;justify-content:flex-end;grid-column:3}
.mc-vr .chip{justify-self:end}
.mc-done{display:flex;flex-direction:column;gap:10px}
.mc-done b{font-size:13px;color:var(--text)}

.mc-trow{display:grid;grid-template-columns:minmax(0,1fr) 64px 62px 84px;gap:8px;align-items:center;height:28px;padding:0 8px;border:0;background:transparent;width:100%;text-align:left;font-size:11.5px;border-radius:6px;color:var(--text2);font-variant-numeric:tabular-nums}
button.mc-trow:hover{background:var(--surface-inset)}
.mc-trow[data-sel=true]{background:color-mix(in srgb,var(--primary) 12%,var(--bg))}
.mc-trow[data-k=hd]{font-size:9.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--text3);font-weight:600;height:24px}
.mc-trow .tl{display:flex;gap:6px;align-items:center;min-width:0}
.mc-trow .tn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.mc-trow small{color:var(--text3);font-size:9.5px;white-space:nowrap}
.mc-trow[data-k=proj]{font-weight:600;letter-spacing:.05em;font-size:10.5px;margin-top:6px}
.mc-trow[data-k=proj] .tn{text-transform:uppercase}
.mc-trow[data-k=chk]{padding-left:22px;font-weight:500}
.mc-trow[data-k=prc]{padding-left:38px}
.mc-trow[data-k=prc] .tn{color:var(--text2)}
.mc-trow[data-k=rest]{color:var(--text3);border-top:${LINE};border-radius:0;margin-top:6px}
.mc-trow[data-k=rest] .tn{color:var(--text3)}
.mc-trow[data-k=more]{padding-left:38px;color:var(--info);display:block;height:26px;font-size:10.5px;line-height:26px}
.mc-trow .r{text-align:right}
.mc-trow .r.hot{color:var(--warning-ink,var(--warning))}
.mc-car{display:inline-grid;transition:transform .15s var(--ease-out,ease);color:var(--text3)}
.mc-car[data-shut=true]{transform:rotate(-90deg)}
.mc-gd{width:5px;height:5px;border-radius:50%;background:var(--success);flex:none}
.mc-spark{justify-self:end}

.mc-spf{flex:none;border-top:${LINE};background:var(--surface-nav);padding:8px 14px;display:flex;flex-direction:column;gap:8px;max-height:36%;overflow:auto}
.mc-spt{display:flex;align-items:center;gap:10px;font-size:11.5px;flex-wrap:wrap}
.mc-spt b{font-weight:600;color:var(--text)}
.mc-spt .grow{flex:1}
.mc-spt .ok{color:var(--success-ink,var(--success))}
.mc-spt .err{color:var(--error-ink,var(--error))}
.mc-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.mc-stt{display:flex;flex-direction:column;gap:3px;min-width:0;padding:4px 9px;border-radius:9px;background:var(--bg)}
.mc-stt small{font-size:9.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--text3);font-weight:600}
.mc-stt b{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.mc-spr{display:grid;grid-template-columns:140px 140px 90px 1fr;gap:10px;align-items:center;font-size:11px;color:var(--text2)}
.mc-spr .r{text-align:right}
.mc-spr small{color:var(--warning-ink,var(--warning));font-size:10px}
.mc-bar2{height:6px;border-radius:3px;background:var(--bg3);display:flex;overflow:hidden}
.mc-bar2 i{display:block;background:var(--text3)}
.mc-bar2 i[data-rb=true]{background:var(--warning)}

.mc-locks{flex:1;min-width:0;overflow:auto}
.mc-lock{display:grid;grid-template-columns:14px minmax(0,1fr) minmax(0,auto) 92px;gap:10px;align-items:center;min-height:46px;padding:4px 14px;border-top:${LINE};position:relative}
.mc-lock[data-click=true]{cursor:pointer}
.mc-lock:hover{background:var(--surface-inset)}
.mc-lock[data-sel=true]{background:color-mix(in srgb,var(--primary) 8%,var(--bg))}
.mc-lock .dot{width:7px;height:7px;border-radius:50%;background:var(--success);justify-self:center}
.mc-lock[data-stale=true] .dot{background:var(--warning)}
.mc-lock .nm{font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mc-lock .sub{font-size:10.5px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mc-lock .pa{display:flex;justify-content:flex-end;opacity:0;transition:opacity .12s}
.mc-lock:hover .pa,.mc-lock:focus-within .pa,.mc-lock[data-sel=true] .pa{opacity:1}
`;
