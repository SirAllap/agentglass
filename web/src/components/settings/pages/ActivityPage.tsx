import { useEffect, useMemo, useState } from "react";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { Section } from "../shell/Section.tsx";
import { StatusBadge } from "../../SettingsKit.tsx";
import { Select } from "../../Select.tsx";
import { Button, INPUT, INPUT_STYLE, LINE, Segmented } from "../../workspace/Chrome.tsx";
import { api } from "../../../lib/api.ts";
import { activityDays, dayId, mergeActivity, type ActivityRow } from "../../../lib/activity.ts";
import {
  FEED_FILTERS, exactTime, filterCounts, lineOf, narrow, relativeTime, whoOptions, type FeedFilter,
} from "../../../lib/activityFeed.ts";
import type { ActionRecord, GateRecord } from "../../../../../shared/types.ts";
import type { PageCtx } from "./ctx.ts";

const DAYS_SHOWN = 2;

/** One event: who did what, when (relative, with the exact time on hover). Decisions live in lib/activityFeed.ts. */
function FeedRow({ row, times, now }: { row: ActivityRow; times: number; now: number }) {
  const l = lineOf(row);
  // An event is a read-out, not a setting: a list item, not a row with a control.
  return (
    <li className="flex items-start gap-3 px-3 py-2 text-[12.5px]" style={{ borderTop: LINE, color: "var(--text)" }}>
      <span className="min-w-0 flex-1">
        <span className="break-words"><b>{l.who}</b> {l.what}{times > 1 && <span className="t-dim tabular-nums"> ×{times}</span>}</span>
        {(l.failure || l.sub) && <span className="block text-[12px] break-words" style={{ color: l.failure ? "var(--error-ink)" : "var(--text2)" }}>{l.failure || l.sub}</span>}
      </span>
      {!l.ok && <StatusBadge tone="err">Failed</StatusBadge>}
      <span className="text-[11.5px] t-dim tabular-nums whitespace-nowrap" tabIndex={0} data-tip={exactTime(row.at)}>{relativeTime(row.at, now)}</span>
    </li>
  );
}

function ActivityFeed({ open }: { open: boolean }) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [who, setWho] = useState("");
  const [query, setQuery] = useState("");
  const [older, setOlder] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    let alive = true;
    Promise.all([
      api.actions(200).then((r) => r.actions).catch(() => [] as ActionRecord[]),
      api.gateHistory(200, { ruleAllows: false }).then((r) => r.gates).catch(() => [] as GateRecord[]),
      api.gateHistory(50).then((r) => r.gates).catch(() => [] as GateRecord[]),
    ]).then(([a, g, recent]) => {
      if (!alive) return;
      const seen = new Set(g.map((x) => x.id));
      setRows(mergeActivity(a, [...g, ...recent.filter((x) => !seen.has(x.id))]));
      setNow(Date.now());
    });
    return () => { alive = false; };
  }, [open]);

  const counts = useMemo(() => filterCounts(narrow(rows ?? [], { filter: "all", who, query })), [rows, who, query]);
  const people = useMemo(() => whoOptions(rows ?? []), [rows]);
  const days = useMemo(() => activityDays(narrow(rows ?? [], { filter, who, query })), [rows, filter, who, query]);

  if (!rows) return <Section id="activity-state" title="What this app has done"><div data-skeleton className="px-3 py-2.5 text-[12px]" style={{ color: "var(--text2)" }}>Reading the activity…</div></Section>;
  if (!rows.length) return (
    <Section id="activity-state" title="What this app has done" intro="Every write this app makes is listed here as it happens.">
      <p className="px-3 py-2.5 text-[12px]" style={{ color: "var(--text2)" }}>
        Nothing yet. Git and pull request actions, container actions, approvals, what an agent changed through the app, and
        policy rules turning on or off are listed. A setting you change by hand in this screen is not listed.
      </p>
    </Section>
  );

  const shown = days.filter((_, i) => older || i < DAYS_SHOWN);
  return (
    <>
      <Section id="find" title="Find an event">
        <SettingRow kind="control" agentExempt label="Show"
          control={<Segmented label="Kind of event" value={filter} onChange={setFilter} track
            options={FEED_FILTERS.map((f) => ({ id: f.id, label: `${f.label} ${counts[f.id]}` }))} />} />
        <SettingRow kind="control" agentExempt label="Who"
          control={<Select value={who} onChange={setWho}
            options={[{ value: "", label: "Everyone" }, ...people.map((p) => ({ value: p.who, label: `${p.who} (${p.n})` }))]} />} />
        {/* A text field gets the row's full width, under the choices, not the control column. */}
        <div className="px-3 py-2.5">
          <input type="search" className={`${INPUT} w-full`} style={INPUT_STYLE} value={query} placeholder="Search activity…" aria-label="Search activity" onChange={(e) => setQuery(e.target.value)} />
        </div>
      </Section>
      {!days.length && (
        <Section id="no-match" title="No match">
          <SettingRow kind="control" agentExempt label="Nothing fits these filters"
            control={<Button onClick={() => { setFilter("all"); setWho(""); setQuery(""); }}>Clear filters</Button>} />
        </Section>
      )}
      {shown.map(({ day, runs }) => (
        <Section key={day} id={dayId(day)} title={day}>
          <ul>{runs.map((r) => <FeedRow key={r.key} row={r} times={r.times} now={now} />)}</ul>
        </Section>
      ))}
      {!older && days.length > DAYS_SHOWN && (
        <Section id="older" title="Older entries">
          <SettingRow kind="control" agentExempt label="Earlier days" help="Kept indefinitely; shown on request."
            control={<Button onClick={() => setOlder(true)}>Show</Button>} />
        </Section>
      )}
    </>
  );
}

/** System > Activity: readable sentences, grouped by day, filterable by kind, person and text. */
export function ActivitySettingsPage({ c }: { c: PageCtx }) {
  return (
    <SettingsPage
      title="Activity"
      purpose="The changes this app made for you, newest first. It is not telemetry."
      sections={[{ id: "activity", title: "What this app has done", kind: "normal", body: <div data-section="activity"><ActivityFeed open={c.open} /></div> }]}
    />
  );
}
