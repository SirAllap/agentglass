/*
 * The failing part of a failed check, where the check is: the Checks tab.
 *
 * A red check used to end in "Details ↗" and a browser. This opens the check onto
 * the test that failed and only that — the excerpt, a copy button per failure —
 * and says so plainly when there is nothing to show (the log expired, was too
 * large, names no test, GitHub's budget is spent). "Open full log" sits in the
 * same place in every one of those states, because it is the way out of all of
 * them. The decisions are in lib/checkFailures.ts; the requests in
 * lib/checkFailuresStore.ts; the cutting in server/src/ciFailures.ts.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { CiFailure, PrCheck, PrCheckJob } from "../../../shared/types.ts";
import { ArrowIcon, CaretIcon, ClockIcon, CopyIcon, DoneIcon, FileIcon, RefreshIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { externalUrl } from "../lib/externalUrl.ts";
import { ICON } from "../lib/iconSize.ts";
import { Button, EDGE, IconChip, LINE } from "./workspace/Chrome.tsx";
import { CODE_FONT_STYLE } from "./diff/DiffLines.tsx";
import { Spinner } from "./Spinner.tsx";
import { failureGist, failureCopyText, failureView, formatBytes, logAgeDays, plural, readLine, resetClock, type FailureView } from "../lib/checkFailures.ts";
import { failureKey, isAsking, load, readOf, useFailureStore } from "../lib/checkFailuresStore.ts";

/** A small word on a quiet tint: the shape of the mockup's "cached" and "Log expired". */
function Tag({ children, tone = "plain", title }: { children: ReactNode; tone?: "plain" | "warn"; title?: string }) {
  const ink = tone === "warn" ? "var(--warning-ink)" : "var(--text2)";
  const hue = tone === "warn" ? "var(--warning)" : "var(--text)";
  return (
    <span title={title} className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-px rounded-full"
      style={{ color: ink, background: `color-mix(in srgb, ${hue} ${tone === "warn" ? 12 : 8}%, transparent)` }}>{children}</span>
  );
}

/** The line a person looks for: what the tool said went wrong, in the error ink, the rest quiet. */
const ERROR_LINE = /^\s*(error\b|E {2,}|AssertionError|[A-Za-z.]*(Error|Exception)\b|Process completed|FAIL\b|expect\()/;

function Excerpt({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto text-[10.5px] max-h-80 agx-scroll px-2.5 py-2 m-0 whitespace-pre"
      style={{ ...CODE_FONT_STYLE, color: "var(--text2)", background: "var(--surface-inset)" }}>
      {text.split("\n").map((l, i) => (
        <span key={i} className="block" style={ERROR_LINE.test(l) ? { color: "var(--error-ink)", fontWeight: 600 } : undefined}>{l || " "}</span>
      ))}
    </pre>
  );
}

/** One failure: its name, what it said in a few words, a copy button, and the excerpt when open. */
function FailureRow({ f, open, onToggle, first }: { f: CiFailure; open: boolean; onToggle: () => void; first: boolean }) {
  const gist = failureGist(f);
  return (
    <div style={first ? undefined : { borderTop: LINE }}>
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button onClick={onToggle} aria-expanded={open} className="flex-1 min-w-0 flex items-center gap-2 text-left">
          <span aria-hidden className="shrink-0 flex" style={{ color: "var(--text3)", transform: open ? undefined : "rotate(-90deg)" }}><CaretIcon size={ICON.xs} /></span>
          <span className="truncate font-semibold min-w-0" title={f.title} style={{ ...CODE_FONT_STYLE, color: "var(--text)" }}>{f.title}</span>
          {!open && gist && <Tag title={gist}><span className="truncate max-w-[16rem]">{gist}</span></Tag>}
        </button>
        <CopyFailure f={f} />
      </div>
      {open && <Excerpt text={f.excerpt} />}
    </div>
  );
}

/** Bottom of every state: the way out on the left, the one thing that can be done about the state on the right. */
function Footer({ url, note, action }: { url: string; note?: ReactNode; action?: ReactNode }) {
  const href = externalUrl(url);
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ borderTop: LINE, minHeight: 40 }}>
      {href
        ? <a href={href} target="_blank" rel="noreferrer noopener" className="shrink-0 text-[10.5px] inline-flex items-center gap-1 hover:underline" style={{ color: "var(--primary-ink)" }}>
            <ArrowIcon size={ICON.xs} />Open full log
          </a>
        : <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>No link to the log</span>}
      <span className="ml-auto min-w-0 truncate text-[10px] tabular-nums" style={{ color: "var(--text3)" }}>{note}</span>
      {action}
    </div>
  );
}

const Heading = ({ children }: { children: ReactNode }) => <div className="text-[12px] font-semibold mb-1" style={{ color: "var(--text)" }}>{children}</div>;
const Body = ({ children }: { children: ReactNode }) => <div className="text-[10.5px] leading-relaxed" style={{ color: "var(--text2)", maxWidth: "52ch" }}>{children}</div>;

/** Reading: what it is doing, with the boxes the result will fill so nothing moves when it lands. */
function Loading() {
  const step = (done: boolean, now: boolean, text: string) => (
    <div className="flex items-center gap-2 text-[10.5px]" style={{ color: done || now ? "var(--text2)" : "var(--text4)" }}>
      <span className="shrink-0 w-3 flex justify-center">
        {done ? <span style={{ color: "var(--success-ink)" }}><DoneIcon size={ICON.xs} /></span> : now ? <RefreshIcon size={ICON.xs} className="animate-spin" /> : <span className="rounded-full" style={{ width: 4, height: 4, background: "var(--text4)" }} />}
      </span>
      {text}
    </div>
  );
  const bar = (w: string, h: number, o: number, delay: number) => (
    <div className="agx-sk rounded" style={{ height: h, width: w, background: `color-mix(in srgb, var(--border) ${o}%, transparent)`, animation: `agxpulse 1.4s ease-in-out ${delay}s infinite` }} />
  );
  return (
    <div role="status" aria-live="polite">
      <style>{`@keyframes agxpulse{0%,100%{opacity:.35}50%{opacity:.7}}@media (prefers-reduced-motion:reduce){.agx-sk{animation:none!important}}`}</style>
      <div className="px-2.5 py-1.5" style={{ borderBottom: LINE }}><Spinner label="Reading the log…" className="" /></div>
      <div className="px-2.5 py-2 flex flex-col gap-1.5">
        {step(true, false, "Found the failing job")}
        {step(false, true, "Downloading the log")}
        {step(false, false, "Cutting out the failures")}
      </div>
      <div className="px-2.5 pb-2.5 flex flex-col gap-1.5" aria-hidden>
        {bar("38%", 8, 45, 0)}
        <div className="rounded-lg p-2.5 flex flex-col gap-1.5" style={{ background: "var(--surface-inset)", height: 80 }}>
          {bar("84%", 6, 55, 0.1)}{bar("62%", 6, 45, 0.2)}{bar("74%", 6, 45, 0.3)}{bar("40%", 6, 35, 0.4)}
        </div>
      </div>
    </div>
  );
}

function StateBox({ tag, title, children }: { tag: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="px-2.5 py-2.5 flex flex-col gap-1.5" style={{ minHeight: 120 }}>
      <div>{tag}</div>
      <Heading>{title}</Heading>
      {children}
    </div>
  );
}

export function CheckFailuresPanel({ root, check, job }: { root: string; check: PrCheck; job: PrCheckJob }) {
  useFailureStore();
  const key = failureKey(root, job.id);
  const hints = { attempt: job.attempt, step: job.failedStep };
  // Opening the check is the only thing that asks. A re-render, a poll or the tab switching does not.
  useEffect(() => { void load(root, job.id, hints); }, [root, job.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const view: FailureView = failureView(isAsking(key) && !readOf(key)?.ok ? undefined : readOf(key));
  const [openRows, setOpenRows] = useState<Set<number>>(new Set([0]));
  const toggle = (i: number) => setOpenRows((c) => { const n = new Set(c); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const retry = (force: boolean) => void load(root, job.id, hints, force);
  const age = logAgeDays(check.completedAt);

  let body: ReactNode;
  let note: ReactNode;
  let action: ReactNode;
  switch (view.kind) {
    case "loading":
      body = <Loading />;
      break;
    case "failures": {
      const r = view.read;
      body = (
        <>
          <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ borderBottom: LINE, color: "var(--text3)" }}>
            <span className="shrink-0 flex"><FileIcon size={ICON.xs} /></span>
            <span className="text-[10.5px] truncate">{readLine(r)}</span>
            <span className="ml-auto flex items-center gap-1.5">
              {view.notice === "expired" && <Tag tone="warn" title="GitHub no longer has this log; what is shown is what its annotations kept"><ClockIcon size={ICON.xs} />Log expired</Tag>}
              {view.notice === "toolarge" && <Tag tone="warn" title="The log was too large to read; what is shown is what its annotations kept"><FileIcon size={ICON.xs} />Too large</Tag>}
              {r.cached && <Tag title="Read earlier and kept: opening it again made no request">cached</Tag>}
            </span>
          </div>
          {r.failures.map((f, i) => <FailureRow key={`${i}-${f.signature}`} f={f} first={i === 0} open={openRows.has(i)} onToggle={() => toggle(i)} />)}
          {r.more > 0 && <div className="px-2.5 py-1.5 text-[10.5px]" style={{ borderTop: LINE, color: "var(--text3)" }}>+{r.more} more not shown here. The full log has them.</div>}
        </>
      );
      note = r.failures.length ? plural(r.failures.length + r.more, r.source === "annotations" ? "error" : "failure") : null;
      break;
    }
    case "no-test": {
      const f = view.read.failures[0]!;
      const lines = f.excerpt.split("\n").length;
      body = (
        <div className="px-2.5 py-2.5 flex flex-col gap-1.5">
          <div><Tag tone="warn"><WarningIcon size={ICON.xs} />No test named</Tag></div>
          <Heading>The log names no failing test; here is the end of the step</Heading>
          <div className="rounded-lg overflow-hidden" style={{ border: EDGE }}>
            <div className="flex items-center gap-2 px-2.5 py-1 text-[10px]" style={{ color: "var(--text3)", background: "var(--surface-inset)", ...CODE_FONT_STYLE }}>
              <span className="truncate">Step “{f.title}” · last {plural(lines, "line")}</span>
              <span className="ml-auto"><CopyFailure f={f} /></span>
            </div>
            <Excerpt text={f.excerpt} />
          </div>
        </div>
      );
      break;
    }
    case "expired":
      body = (
        <StateBox tag={<Tag tone="warn"><ClockIcon size={ICON.xs} />Log expired</Tag>} title="GitHub no longer has this log">
          <Body>
            It keeps logs for 90 days{age != null ? ` and this run is ${plural(age, "day")} old` : ""}. The check itself is still recorded as failed{job.failedStep ? `, in the step “${job.failedStep}”` : ""}.
          </Body>
        </StateBox>
      );
      break;
    case "toolarge":
      body = (
        <StateBox tag={<Tag><FileIcon size={ICON.xs} />Too large</Tag>} title={view.size ? `This log is ${formatBytes(view.size)}` : "This log is too large"}>
          <Body>The panel reads up to 25 MB, so it did not download it. {view.canForce ? "One request will; the result is kept." : "It is over what the panel can take, so it opens on GitHub."}</Body>
        </StateBox>
      );
      action = view.canForce ? <Button size="compact" onClick={() => retry(true)}>Read it anyway</Button> : undefined;
      break;
    case "unparsed":
      body = (
        <StateBox tag={<Tag tone="warn"><WarningIcon size={ICON.xs} />Not recognised</Tag>} title="Nothing in this log looks like a failure">
          <Body>{job.failedStep ? `The step that failed is “${job.failedStep}”. ` : ""}The log has no test report and no exit code the panel can read, so it shows none rather than a guess.</Body>
        </StateBox>
      );
      break;
    case "budget": {
      const at = resetClock(view.resetAt);
      const waiting = view.resetAt != null && view.resetAt > Date.now();
      body = (
        <StateBox tag={<Tag tone="warn"><WarningIcon size={ICON.xs} />Budget spent</Tag>} title="GitHub’s hourly budget is used up">
          <Body>{at ? `It resets at ${at}. ` : ""}Nothing is lost: the excerpt is read the next time this opens, and then kept.</Body>
        </StateBox>
      );
      action = <Button size="compact" disabled={waiting} onClick={() => retry(false)}>{at ? `Try again at ${at}` : "Try again"}</Button>;
      break;
    }
    case "error":
      body = (
        <StateBox tag={<Tag tone="warn"><WarningIcon size={ICON.xs} />Could not read it</Tag>} title="The failure could not be read">
          <Body>{view.error}</Body>
        </StateBox>
      );
      action = <Button size="compact" onClick={() => retry(false)}>Try again</Button>;
      break;
  }

  return (
    <div className="mx-2.5 mb-2 rounded-xl overflow-hidden text-[11px]" style={{ border: EDGE, background: "var(--surface-card)" }}>
      {body}
      <Footer url={job.url || check.url || ""} note={note} action={action} />
    </div>
  );
}

function CopyFailure({ f }: { f: CiFailure }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconChip onClick={() => { void navigator.clipboard.writeText(failureCopyText(f)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }, () => { /* refused */ }); }} title={copied ? "Copied" : "Copy this failure"}>
      {copied ? <DoneIcon size={ICON.xs} /> : <CopyIcon size={ICON.xs} />}
    </IconChip>
  );
}
