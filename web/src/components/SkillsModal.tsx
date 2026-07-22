import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { SkillInfo } from "../../../shared/types.ts";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import { fmtAgo, fmtUsd } from "../lib/format.ts";

type Kind = "all" | "skill" | "command";
type Usage = "all" | "used" | "never";
type Sort = "grouped" | "used" | "recent" | "newest" | "oldest" | "az";

const SORTS: { key: Sort; label: string }[] = [
  { key: "grouped", label: "by category" },
  { key: "used", label: "most used" },
  { key: "recent", label: "recently used" },
  { key: "newest", label: "newest" },
  { key: "oldest", label: "oldest" },
  { key: "az", label: "a–z" },
];

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span className="chip shrink-0 font-semibold" style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)`, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}>
      {text}
    </span>
  );
}

function chipStyle(active: boolean, color = "var(--primary)") {
  return active
    ? { color, background: `color-mix(in srgb, ${color} 16%, transparent)`, borderColor: `color-mix(in srgb, ${color} 50%, transparent)` }
    : { color: "var(--text4)" };
}

function SkillCard({ s, isNew, isTop, expanded, onToggle }: { s: SkillInfo; isNew: boolean; isTop: boolean; expanded: boolean; onToggle: () => void }) {
  const [copied, setCopied] = useState(false);
  const invoke = `/${s.name}`;
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(invoke).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  const perRun = s.calls > 0 && s.cost_usd > 0 ? s.cost_usd / s.calls : 0;

  return (
    <div
      onClick={onToggle}
      className="rounded-xl px-3.5 py-2.5 cursor-pointer transition-colors"
      style={{
        background: expanded ? "color-mix(in srgb, var(--primary) 8%, transparent)" : "color-mix(in srgb, var(--bg3) 35%, transparent)",
        border: `1px solid color-mix(in srgb, ${expanded ? "var(--primary)" : "var(--border)"} 40%, transparent)`,
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-semibold text-[12.5px] truncate" style={{ color: "var(--primary)" }}>{invoke}</span>
        <button
          onClick={copy}
          title={`Copy ${invoke} to clipboard`}
          className="chip shrink-0 cursor-pointer"
          style={copied ? { color: "var(--success)", borderColor: "color-mix(in srgb, var(--success) 45%, transparent)" } : { color: "var(--text4)" }}
        >
          {copied ? "copied ✓" : "copy"}
        </button>
        {isTop && <Badge text="top" color="var(--warning)" />}
        {isNew && <Badge text="new" color="var(--success)" />}
        <span className="ml-auto flex items-center gap-2 shrink-0 text-[10px] t-dim2">
          {s.calls > 0 ? (
            <span className="tabular-nums" style={{ color: "var(--text3)" }}>{s.calls}× {s.last_used ? `· ${fmtAgo(s.last_used)}` : ""}</span>
          ) : (
            <span>never used</span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-1.5 mt-1 text-[9.5px] t-dim2 flex-wrap">
        <span className="chip">{s.kind}</span>
        <span className="chip">{s.category}</span>
        <span className="chip">{s.source}</span>
        <span>added {fmtAgo(s.added)} ago</span>
        {s.copies > 1 && <span>· ×{s.copies} copies</span>}
        {perRun > 0 && <span className="tabular-nums" style={{ color: "var(--success)" }}>· ~{fmtUsd(perRun)}/run</span>}
      </div>
      {/* The "reach for this when…" line — the answer to "which skill do I use here?" */}
      {s.when_to_use && (
        <div
          className="mt-1.5 text-[10.5px] leading-snug"
          style={{
            color: "var(--info)",
            ...(expanded ? {} : { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const, overflow: "hidden" }),
          }}
        >
          → {s.when_to_use}
        </div>
      )}
      <div
        className="mt-1.5 text-[11px] leading-relaxed t-dim"
        style={
          expanded
            ? undefined
            : { display: "-webkit-box", WebkitLineClamp: s.when_to_use ? 1 : 2, WebkitBoxOrient: "vertical", overflow: "hidden" }
        }
      >
        {s.description || <span className="t-dim2 italic">no description — add one to its frontmatter</span>}
      </div>
      {expanded && (
        <div className="mt-2 pt-2 border-t flex flex-col gap-1 text-[10.5px]" style={{ borderColor: "color-mix(in srgb, var(--border) 30%, transparent)" }}>
          <div className="flex items-center gap-2">
            <span className="t-dim2">invoke: </span>
            <code style={{ color: "var(--text2)" }}>{invoke}{s.argument_hint ? ` ${s.argument_hint}` : ""}</code>
          </div>
          {s.cost_usd > 0 && (
            <div className="t-dim2">
              attributed cost: <span className="tabular-nums" style={{ color: "var(--success)" }}>{fmtUsd(s.cost_usd)}</span> total · ~{fmtUsd(perRun)}/run
            </div>
          )}
          <div className="t-dim2 truncate" title={s.path}>{s.path}</div>
        </div>
      )}
    </div>
  );
}

export function SkillsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [usage, setUsage] = useState<Usage>("all");
  const [category, setCategory] = useState<string>("all");
  const [sort, setSort] = useState<Sort>("grouped");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api.skills().then((r) => setSkills(r.skills)).catch(() => setSkills([]));
    setQ("");
    setExpanded(null);
  }, [open]);

  const all = skills ?? [];
  // Highlights are computed over the whole catalog, not the filtered view.
  const topNames = useMemo(
    () => new Set(all.filter((s) => s.calls > 0).sort((a, b) => b.calls - a.calls).slice(0, 3).map((s) => s.name)),
    [all]
  );
  const newNames = useMemo(
    () => new Set([...all].sort((a, b) => b.added - a.added).slice(0, 3).map((s) => s.name)),
    [all]
  );

  // Category chips with counts, largest first.
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of all) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);

  const shown = useMemo(() => {
    let list = all;
    if (kind !== "all") list = list.filter((s) => s.kind === kind);
    if (usage === "used") list = list.filter((s) => s.calls > 0);
    if (usage === "never") list = list.filter((s) => s.calls === 0);
    if (category !== "all") list = list.filter((s) => s.category === category);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((s) => `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(needle));
    }
    const by: Record<Exclude<Sort, "grouped">, (a: SkillInfo, b: SkillInfo) => number> = {
      used: (a, b) => b.calls - a.calls || a.name.localeCompare(b.name),
      recent: (a, b) => (b.last_used ?? 0) - (a.last_used ?? 0) || a.name.localeCompare(b.name),
      newest: (a, b) => b.added - a.added || a.name.localeCompare(b.name),
      oldest: (a, b) => a.added - b.added || a.name.localeCompare(b.name),
      az: (a, b) => a.name.localeCompare(b.name),
    };
    // Grouped view sorts by usage inside each category section.
    return [...list].sort(sort === "grouped" ? by.used : by[sort]);
  }, [all, kind, usage, category, q, sort]);

  // Section list for the grouped view: categories in chip order, most-used first inside.
  const sections = useMemo(() => {
    if (sort !== "grouped") return null;
    const order = categories.map(([c]) => c);
    const bySection = new Map<string, SkillInfo[]>();
    for (const s of shown) {
      const arr = bySection.get(s.category) ?? [];
      arr.push(s);
      bySection.set(s.category, arr);
    }
    return order.filter((c) => bySection.has(c)).map((c) => ({ category: c, items: bySection.get(c)! }));
  }, [sort, shown, categories]);

  const used = all.filter((s) => s.calls > 0).length;

  return (
    // Above the workspace's portal, not merely after it: the rail opens this
    // from inside the workspace, and at equal z the frame — which mounts later
    // — would paint straight over the catalog.
    <Portal z={10100}>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0" style={{ zIndex: 10000, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }} onClick={onClose} />
            {/* Flex wrapper centers the card — Motion owns `transform` for its
                scale/y animation, so Tailwind translate centering can't be used. */}
            <div className="fixed inset-0 flex items-center justify-center p-6 pointer-events-none" style={{ zIndex: 10001 }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 14 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ type: "spring", stiffness: 330, damping: 30 }}
              className="w-[min(1320px,96vw)] h-[min(960px,92vh)] rounded-2xl flex flex-col pointer-events-auto"
              style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.8)" }}
            >
              <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                <div className="flex items-baseline gap-2.5 flex-wrap">
                  <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>Skills explorer</span>
                  {skills && (
                    <span className="text-[10px] t-dim2 tabular-nums">
                      {all.length} available · {all.filter((s) => s.kind === "skill").length} skills · {all.filter((s) => s.kind === "command").length} commands · {used} used recently · {all.length - used} to discover
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <a href={api.skillsExportUrl("md")} className="chip" style={{ color: "var(--text3)" }} onClick={(e) => e.stopPropagation()}>↓ md</a>
                  <a href={api.skillsExportUrl("csv")} className="chip" style={{ color: "var(--text3)" }} onClick={(e) => e.stopPropagation()}>↓ csv</a>
                  <a href={api.skillsExportUrl("json")} className="chip" style={{ color: "var(--text3)" }} onClick={(e) => e.stopPropagation()}>↓ json</a>
                  <button onClick={onClose} className="text-[18px] leading-none px-2 t-dim2 hover:opacity-70">✕</button>
                </div>
              </div>

              <div className="flex items-center gap-2 px-5 py-2.5 shrink-0 flex-wrap">
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search skills — name or description…"
                  className="flex-1 min-w-[180px] px-3 py-1.5 rounded-lg text-[11px] outline-none"
                  style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)", color: "var(--text)" }}
                />
                <div className="flex gap-1">
                  {(["all", "skill", "command"] as Kind[]).map((k) => (
                    <button key={k} onClick={() => setKind(k)} className="chip cursor-pointer" style={chipStyle(kind === k)}>
                      {k === "all" ? "all" : k + "s"}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1">
                  {(["used", "never"] as Usage[]).map((u) => (
                    <button key={u} onClick={() => setUsage((cur) => (cur === u ? "all" : u))} className="chip cursor-pointer" style={chipStyle(usage === u, "var(--warning)")}>
                      {u === "never" ? "never used" : "used"}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1">
                  {SORTS.map((s) => (
                    <button key={s.key} onClick={() => setSort(s.key)} className="chip cursor-pointer" style={chipStyle(sort === s.key, "var(--info)")}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* category chips — the discovery rail */}
              <div className="flex items-center gap-1 px-5 pb-2 shrink-0 flex-wrap">
                <button onClick={() => setCategory("all")} className="chip cursor-pointer" style={chipStyle(category === "all")}>
                  all categories
                </button>
                {categories.map(([c, n]) => (
                  <button key={c} onClick={() => setCategory((cur) => (cur === c ? "all" : c))} className="chip cursor-pointer" style={chipStyle(category === c)}>
                    {c} <span className="tabular-nums opacity-60">{n}</span>
                  </button>
                ))}
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4">
                {!skills && <div className="t-dim2 text-center py-10 text-[12px]">loading catalog…</div>}
                {skills && shown.length === 0 && <div className="t-dim2 text-center py-10 text-[12px]">nothing matches</div>}
                {sections ? (
                  sections.map(({ category: c, items }) => (
                    <div key={c} className="mb-4">
                      <div className="flex items-baseline gap-2 mb-2 sticky top-0 py-1" style={{ background: "var(--bg2)", zIndex: 1 }}>
                        <span className="panel-eyebrow">{c}</span>
                        <span className="text-[9.5px] t-dim2 tabular-nums">{items.length}</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
                        {items.map((s) => (
                          <SkillCard
                            key={`${s.kind}:${s.name}`}
                            s={s}
                            isTop={topNames.has(s.name)}
                            isNew={newNames.has(s.name)}
                            expanded={expanded === `${s.kind}:${s.name}`}
                            onToggle={() => setExpanded((e) => (e === `${s.kind}:${s.name}` ? null : `${s.kind}:${s.name}`))}
                          />
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
                    {shown.map((s) => (
                      <SkillCard
                        key={`${s.kind}:${s.name}`}
                        s={s}
                        isTop={topNames.has(s.name)}
                        isNew={newNames.has(s.name)}
                        expanded={expanded === `${s.kind}:${s.name}`}
                        onToggle={() => setExpanded((e) => (e === `${s.kind}:${s.name}` ? null : `${s.kind}:${s.name}`))}
                      />
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
