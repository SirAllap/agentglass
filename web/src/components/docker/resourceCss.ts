/*
 * The rules of the Images, Volumes, Networks and Disk views: the card grids,
 * the cards' parts, the volume panel and the disk bar. Containers' rules are in
 * dockerCss.ts and these reuse its sentence, answer cards, banner and skeleton.
 * Theme tokens only, so light and dark both come from index.css.
 */
import { EDGE, LINE } from "../workspace/Chrome.tsx";

export const RESOURCE_CSS = `
.dk-xs{flex:1;min-height:0;overflow:auto;padding:16px 18px 24px}
.dk-xs>.dk-say{margin-bottom:12px}
.dk-note{margin:0 0 14px;padding:8px 10px;border-radius:9px;font-size:11.5px;display:flex;gap:8px;align-items:center;color:var(--text2);background:color-mix(in srgb,var(--tint) 8%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tint) 25%,transparent)}
.dk-note svg{color:var(--tint);flex:none}
.dk-hnote{padding:8px 10px;border-radius:9px;background:color-mix(in srgb,var(--error) 7%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--error) 28%,transparent);font-size:11.5px;color:var(--text2);display:flex;gap:8px;align-items:flex-start}
.dk-hnote svg{color:var(--error);margin-top:1px;flex:none}
.dk-hnote code{font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;color:var(--text)}
.dk-xg{display:flex;align-items:center;gap:10px;margin:18px 0 8px;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--text3);font-weight:600}
.dk-xg .t{font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;letter-spacing:0;text-transform:none;font-weight:400}
.dk-xg::after{content:"";flex:1;height:1px;background:var(--surface-line);order:3}
.dk-answers+.dk-xg,.dk-note+.dk-xg{margin-top:4px}
.dk-xgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));gap:10px;align-items:start}
.dk-xgrid[data-net=true]{grid-template-columns:repeat(auto-fill,minmax(460px,1fr))}
.dk-xk{position:relative;border:${EDGE};border-radius:12px;background:var(--bg);box-shadow:0 1px 2px color-mix(in srgb,var(--text) 6%,transparent);display:flex;flex-direction:column;min-width:0;overflow:clip;text-align:left;font:inherit;color:inherit}
.dk-xk[data-click=true]{cursor:pointer}
.dk-xk[data-click=true]:hover{border-color:color-mix(in srgb,var(--primary) 30%,transparent)}
.dk-xk[data-click=true]:focus-visible{outline:2px solid var(--primary);outline-offset:-2px}
.dk-xk[data-sel=true]{border-color:color-mix(in srgb,var(--primary) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 11%,transparent)}
.dk-xk[data-dim=true]{background:color-mix(in srgb,var(--bg2) 45%,var(--bg))}
.dk-xk[data-dim=true] .dk-xn{color:var(--text3)}
.dk-xt{display:grid;grid-template-columns:22px minmax(0,1fr) 28px 28px;gap:8px;align-items:center;padding:10px 8px 0 10px}
.dk-xt .nm{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden}
.dk-xn{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto}
.dk-xn[data-none=true]{color:var(--text4);font-weight:500}
.dk-tag,.dk-kind,.dk-drv,.dk-pchip{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 6px;border-radius:6px;font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;color:var(--text2);background:var(--surface-inset);box-shadow:inset 0 0 0 1px var(--surface-line)}
.dk-tag{display:inline-block;line-height:20px}
.dk-tag[data-t=latest],.dk-drv,.dk-pchip[data-web=true]{color:var(--info);background:color-mix(in srgb,var(--info) 7%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--info) 26%,transparent)}
.dk-tag[data-t=none]{color:var(--text4)}
.dk-kind{max-width:none;font-size:10.5px;padding:0 7px;color:var(--merged-ink);background:color-mix(in srgb,var(--merged) 8%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--merged) 28%,transparent)}
.dk-kind[data-k=nm]{color:var(--warning-ink,var(--warning));background:color-mix(in srgb,var(--warning) 9%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--warning) 30%,transparent)}
.dk-drv{max-width:none;font-size:10.5px;padding:0 7px}
.dk-drv[data-d=host],.dk-drv[data-d=null]{color:var(--text3);background:var(--surface-inset);box-shadow:inset 0 0 0 1px var(--surface-line)}
.dk-drv[data-d=overlay]{color:var(--merged-ink);background:color-mix(in srgb,var(--merged) 8%,var(--bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--merged) 28%,transparent)}
.dk-xb{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 12px 0 40px}
.dk-xk .dk-act:disabled{color:var(--text4);background:transparent;box-shadow:none}
.dk-xbar{height:6px;border-radius:3px;background:var(--bg3);overflow:hidden;display:block}
.dk-xbar i{display:block;height:100%;border-radius:3px;background:var(--t,var(--primary))}
.dk-xsz{font-family:var(--font-mono,ui-monospace,monospace);font-size:11.5px;font-weight:600;color:var(--text2);min-width:56px;text-align:right}
.dk-xf{display:flex;align-items:center;gap:6px 8px;padding:8px 12px 10px 40px;min-height:40px;flex-wrap:wrap}
.dk-xwhy{padding:0 12px 10px 40px;font-size:11px;color:var(--text3);line-height:1.4}
.dk-xe{font-size:11px;color:var(--text3)}
.dk-xage{margin-left:auto;font-size:10.5px;color:var(--text3);white-space:nowrap}
.dk-avs{display:flex;gap:4px;flex-wrap:wrap;min-width:0}
.dk-cav{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px 0 5px;border-radius:11px;border:${EDGE};background:var(--bg);font:inherit;font-size:11px;color:var(--text2);max-width:160px;flex:none;min-width:0}
button.dk-cav:hover{border-color:color-mix(in srgb,var(--primary) 40%,transparent);background:color-mix(in srgb,var(--primary) 5%,var(--bg))}
.dk-cav span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dk-cav svg{width:13px;height:13px;flex:none;overflow:visible}
.dk-cav[data-rest=true]{padding:0 7px;color:var(--text3)}
.dk-xsub{padding:2px 12px 10px 40px;font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;color:var(--text3)}
.dk-xmem{border-top:${LINE};display:flex;flex-direction:column}
.dk-xm{display:grid;grid-template-columns:minmax(0,170px) minmax(0,1fr) auto;gap:8px;align-items:center;min-height:36px;padding:0 12px 0 40px;border-bottom:${LINE}}
.dk-xm:last-child{border-bottom:0}
.dk-xm .ports{display:flex;gap:4px;flex-wrap:wrap;min-width:0}
button.dk-pchip{cursor:pointer;border:0}
button.dk-pchip:hover{color:var(--primary-ink,var(--primary))}
.dk-xm[data-tog=true]{display:block;width:100%;text-align:left;border:0;border-top:${LINE};background:transparent;color:var(--info);font-size:11px;padding-top:8px;padding-bottom:8px;cursor:pointer}
.dk-xm[data-tog=true]:hover{background:var(--surface-inset)}
.dk-xa{display:inline-flex;align-items:center;gap:3px;height:16px;padding:0 6px;border-radius:5px;font-size:10px;white-space:nowrap;color:var(--merged-ink);background:color-mix(in srgb,var(--merged) 11%,transparent)}
.dk-xa svg{flex:none}
.dk-badge{display:inline-flex;align-items:center;gap:4px;height:16px;padding:0 6px;border-radius:5px;font-size:10px;line-height:1;white-space:nowrap;flex:none;color:var(--tint);background:color-mix(in srgb,var(--tint) 11%,transparent)}
.dk-badge svg{flex:none}
.dk-xk .dk-confirm{border-top:${LINE}}

.dk-vdet{border-top:1px solid var(--surface-line);padding:12px 14px;background:var(--surface-nav);display:grid;grid-template-columns:minmax(320px,1fr) minmax(0,2fr);gap:8px 28px;align-items:start;max-height:46%;overflow:auto;flex:none}
.dk-vdi,.dk-vdp{display:flex;flex-direction:column;gap:8px;min-width:0}
.dk-vdh{display:flex;align-items:center;gap:8px;min-height:28px}
.dk-vdh b{font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dk-vdh .dk-btn-end{margin-left:auto}
.dk-vrow{display:grid;grid-template-columns:110px 1fr;gap:10px;font-size:11.5px}
.dk-vrow .k{color:var(--text3)}
.dk-vrow .dk-cav{margin:0 4px 4px 0}
.dk-pk{border-radius:9px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--surface-line);overflow:hidden}
.dk-pk .pr{display:grid;grid-template-columns:20px 1fr 70px 100px;gap:8px;height:28px;align-items:center;padding:0 10px;font-size:11px;border-top:1px solid var(--surface-line)}
.dk-pk .pr:first-child{border-top:0}
.dk-pk .pr[data-head=true]{grid-template-columns:1fr auto;background:var(--surface-inset);color:var(--text3)}
.dk-pk .pr[data-foot=true]{color:var(--text4)}
.dk-pk .lk{border:0;background:transparent;padding:0;color:var(--info);text-align:left;font:inherit;cursor:pointer;min-height:20px}
.dk-pk .pr .r{text-align:right}

.dk-dsk{padding:16px 18px 24px;display:flex;flex-direction:column;gap:14px;flex:1;min-height:0;overflow:auto}
.dk-diskobj{padding:14px 16px;border-radius:12px;border:${EDGE};background:var(--bg);box-shadow:0 1px 2px color-mix(in srgb,var(--text) 6%,transparent)}
.dk-diskobj .h{display:flex;align-items:baseline;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.dk-diskobj .h b{font-size:22px;line-height:1;font-weight:600;letter-spacing:-.01em}
.dk-diskobj .h span{font-size:12px;color:var(--text3)}
.dk-diskobj .h .back{margin-left:auto;font-size:12.5px;font-weight:600;color:var(--success-ink,var(--success));display:inline-flex;align-items:center;gap:6px}
.dk-stp{display:inline-block;width:12px;height:10px;border-radius:2px;background:repeating-linear-gradient(135deg,var(--tint) 0 2px,color-mix(in srgb,var(--tint) 40%,var(--bg)) 2px 4px)}
.dk-stackbar{display:flex;height:22px;border-radius:7px;overflow:hidden;gap:1px;background:var(--surface-inset)}
.dk-stackbar i{display:block;height:100%;background:var(--tint);min-width:0;flex:none}
.dk-stackbar i[data-go=true]{background-image:repeating-linear-gradient(135deg,var(--tint) 0 3px,color-mix(in srgb,var(--tint) 45%,var(--bg)) 3px 6px);transition:width 1.5s linear}
.dk-legend{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:10px}
.dk-lg{display:grid;grid-template-columns:10px minmax(0,1fr);gap:7px;align-items:start;font-size:12px;line-height:1.35;color:var(--text2)}
.dk-lg i{width:10px;height:10px;border-radius:3px;margin-top:3px;background:var(--tint)}
.dk-lg small{display:block;font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;color:var(--text3)}
.dk-choices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
@media (max-width:1250px){.dk-choices{grid-template-columns:repeat(2,minmax(0,1fr))}}
.dk-choice{display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;padding:12px;border-radius:12px;border:${EDGE};background:linear-gradient(180deg,var(--bg),color-mix(in srgb,var(--bg2) 55%,var(--bg)));box-shadow:0 2px 3px -1px color-mix(in srgb,var(--text) 7%,transparent)}
.dk-choice h4{margin:0;font-size:13px;line-height:1.3;font-weight:600;color:var(--text)}
.dk-choice p{margin:3px 0 0;font-size:12px;line-height:1.45;color:var(--text3)}
.dk-choice .now{display:flex;align-items:center;gap:8px;margin-top:8px;font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;line-height:1.2;color:var(--text3);white-space:nowrap;min-height:14px}
.dk-choice .now b{color:var(--success-ink,var(--success));font-weight:600}
.dk-choice .go{display:flex;align-items:center;gap:8px;margin-top:10px;min-height:28px;flex-wrap:wrap}
.dk-choice[data-quiet=true]{background:none;box-shadow:none;border-style:dashed;grid-column:1/-1}
.dk-choice[data-busy=true]{border-color:color-mix(in srgb,var(--primary) 40%,transparent)}
.dk-choice code{font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;background:var(--surface-inset);padding:1px 5px;border-radius:4px;color:var(--text2)}
.dk-gauge{width:110px;height:6px;border-radius:4px;background:var(--bg3);position:relative;flex:none}
.dk-gauge i{position:absolute;inset:0 auto 0 0;border-radius:4px;background:var(--warning)}
.dk-gauge[data-ok=true] i{background:var(--success)}
.dk-gauge u{position:absolute;top:-3px;bottom:-3px;width:2px;border-radius:1px;background:var(--text)}
.dk-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.dk-tags code{font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;background:var(--surface-inset);padding:1px 5px;border-radius:4px;color:var(--text2)}
.dk-sk{display:block;border-radius:7px;background:linear-gradient(90deg,var(--bg3),var(--bg2),var(--bg3));background-size:200% 100%;animation:dk-sh 1.4s linear infinite}
@media (prefers-reduced-motion:reduce){.dk-sk{animation:none}.dk-stackbar i[data-go=true]{transition:none}}
`;
