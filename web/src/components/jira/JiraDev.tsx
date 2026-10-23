/*
 * The rest of what a Jira site's development tool holds for a card: its
 * branches, commits and builds, under the pull requests the Development section
 * already lists (JiraCardPrs, which also takes the tool's pull requests).
 *
 * Nothing here when the tool holds none of the three, and no empty box: the
 * section's own sentence ("No pull request is linked") is about pull requests.
 * The rows are somebody's words (a branch name, a commit message) and are drawn
 * as text. Ceiling: a row is not a link: the app has no view of a branch or a
 * commit to open it in, and a link would send the person out of agentglass, so the
 * address is the row's tooltip and nothing more.
 */
import type { CardDev, CardDevBuild } from "../../../../shared/providers.ts";

const TONE: Record<Exclude<CardDevBuild["state"], "">, string> = { passed: "var(--success-ink)", failed: "var(--error-ink)", running: "var(--info-ink)" };

function Group({ title, left, children }: { title: string; left: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0 mt-2" aria-label={title}>
      <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>{title}</div>
      {children}
      {left > 0 && <div className="text-[10px]" style={{ color: "var(--text4)" }}>and {left} more on the site</div>}
    </div>
  );
}

export function JiraDevLists({ dev }: { dev: CardDev | null | undefined }) {
  if (!dev || (!dev.branches.length && !dev.commits.length && !dev.builds.length)) return null;
  return (
    <>
      {dev.branches.length > 0 && (
        <Group title="Branches" left={dev.counts.branches - dev.branches.length}>
          {dev.branches.map((b) => (
            <div key={`${b.repo}/${b.name}`} className="truncate text-[11px]" title={b.url || b.name} style={{ color: "var(--text2)" }}>
              {b.name}{b.repo && <span className="ml-1.5 text-[10px]" style={{ color: "var(--text4)" }}>{b.repo}</span>}
            </div>
          ))}
        </Group>
      )}
      {dev.commits.length > 0 && (
        <Group title="Commits" left={dev.counts.commits - dev.commits.length}>
          {dev.commits.map((c) => (
            <div key={c.id} className="truncate text-[11px]" title={c.url || c.id} style={{ color: "var(--text2)" }}>
              <span className="tabular-nums mr-1.5 text-[10px]" style={{ color: "var(--text4)" }}>{c.id}</span>{c.message}
            </div>
          ))}
        </Group>
      )}
      {dev.builds.length > 0 && (
        <Group title={dev.buildsFailed || dev.buildsPassed ? `Builds · ${dev.buildsPassed} passed, ${dev.buildsFailed} failed` : "Builds"} left={dev.counts.builds - dev.builds.length}>
          {dev.builds.map((b, i) => (
            <div key={`${b.name}-${i}`} className="truncate text-[11px]" title={b.url || b.name} style={{ color: "var(--text2)" }}>
              {b.name}{b.state && <span className="ml-1.5 text-[10px]" style={{ color: TONE[b.state] }}>{b.state}</span>}
            </div>
          ))}
        </Group>
      )}
    </>
  );
}
