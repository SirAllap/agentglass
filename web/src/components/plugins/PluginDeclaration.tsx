import type { ReactNode } from "react";
import type { DeviceScope, PublicPlugin } from "../../../../shared/types.ts";
import { CopyIcon, EyeIcon, NoteIcon, HandIcon } from "../../lib/glyphIcons.tsx";
import { CommandIcon, PuzzleIcon, ShieldIcon, SlidersIcon } from "../settingsNavIcons.tsx";
import { describeSandbox, type SandboxGrant } from "../../../../shared/pluginSandbox.ts";
import { boxWording, neighbourKeyWording } from "../../lib/pluginBoxState.ts";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { EDGE } from "../workspace/Chrome.tsx";

/**
 * What switching a plugin on approves, drawn rather than recited.
 *
 * It was a paragraph, a `runs:` line and a bulleted list of sentences, in one
 * weight and one colour — the same text in the card and again in the dialog
 * that asks. Nobody reads a wall, and this is the one wall in the app that
 * has to be read: it is the whole consent gate.
 *
 * So: three blocks, each with its own mark. What it can SEE, what it RUNS,
 * and where it DRAWS — the last one a line per surface, because "a panel" and
 * "a button in every pull request" are different sizes of thing to agree to
 * and a list of identical sentences hides that.
 *
 * One component, used in both places, so the card and the dialog cannot drift
 * into describing the same plugin differently.
 */

const SCOPE_SENTENCE: Record<DeviceScope, string> = {
  read: "Everything this app can read: every session's live output as it streams — the same prompts and replies you watch on screen — plus costs, diffs and pull requests. Through this app it can only look: no gate, no reply, no writes.",
  answer: "Everything a reader sees, and it can reply to a session that is already running. Through this app it cannot release a permission gate or start anything.",
  full: "Everything this machine can do: a terminal, git writes, Docker, the browser, releasing permission gates. Give this to code you would run yourself.",
};

/** Whatever the scope: it limits the token, and an UNBOXED process is the
 *  user's. Never shown for a boxed plugin — that would contradict what "What
 *  it asks to be given" says right below it. */
const PROCESS_WARNING = "This plugin runs as you. The scope limits its access to this app, not to your machine: it can still read your files and run programs. Approve it only if you would run its code yourself.";
/** The boxed equivalent: the scope still limits the token, but the process
 *  itself is contained to the folders in the block below, not the whole machine. */
const BOXED_PROCESS_NOTE = "This plugin runs in a box: the scope still limits its access to this app, and the box limits what else it can reach — see what it asks to be given, below.";


const SCOPE_WORD: Record<DeviceScope, string> = { read: "reads the app", answer: "reads and replies", full: "everything" };
const SCOPE_TINT: Record<DeviceScope, string> = { read: "var(--success)", answer: "var(--warning)", full: "var(--error)" };

/** One surface, as the person will meet it: a mark, what it is, and where. */
type Surface = { icon: ReactNode; what: string; where: string };

export function surfaces(p: PublicPlugin): Surface[] {
  const c = p.contributes ?? {};
  const out: Surface[] = [];
  for (const panel of c.panels ?? []) {
    out.push({
      icon: <PuzzleIcon size={ICON.sm} />,
      what: `${panel.canvas ? "Live panel" : "Panel"} · ${panel.title}`,
      where: panel.canvas ? "in the Plugins view, drawn as it happens with the app's own parts: it can move things about, never run code or load anything" : "in the Plugins view",
    });
  }
  if (c.settings?.length) {
    out.push({
      icon: <SlidersIcon size={ICON.sm} />,
      what: `Settings page · ${c.settings.length} ${c.settings.length === 1 ? "field" : "fields"}`,
      where: c.settings.some((f) => f.type === "secret")
        ? "in this window, filled in by you; asks for a secret, kept in a file only you can read (a plugin running outside its box could too)"
        : "in this window, filled in by you",
    });
  }
  if (c.inboxAnnotations) {
    out.push({ icon: <PuzzleIcon size={ICON.sm} />, what: "Badge and sort order on Inbox rows", where: "it can mark and order rows, never hide one" });
  }
  if (c.prNotes) {
    out.push({ icon: <NoteIcon size={ICON.sm} />, what: "Notes on pull requests", where: "shown here only, never sent to GitHub" });
  }
  const actions = c.prActions ?? [];
  if (actions.length) {
    out.push({
      icon: <HandIcon size={ICON.sm} />,
      what: actions.map((a) => `"${a.label}"`).join(", "),
      where: actions.length === 1 ? "a button in every pull request" : "buttons in every pull request",
    });
  }
  return out;
}

export function PluginDeclaration({ plugin }: { plugin: PublicPlugin }) {
  const tint = SCOPE_TINT[plugin.scope];
  const drawn = surfaces(plugin);
  const d = plugin.sandbox ? describeSandbox(plugin.sandbox) : null;
  const box = boxWording(plugin);
  const neighbourKey = neighbourKeyWording(plugin);
  return (
    <div className="flex flex-col gap-2.5 min-w-0">
      <Block icon={<EyeIcon size={ICON.sm} />} tint={tint} head="What it sees" chip={SCOPE_WORD[plugin.scope]}>
        <p className="m-0 text-[12px] leading-relaxed" style={{ color: "var(--text2)" }}>{SCOPE_SENTENCE[plugin.scope]}</p>
      </Block>

      <Block icon={<CommandIcon size={ICON.sm} />} tint={box?.tone === "boxed" ? "var(--primary)" : "var(--warning)"} head="What it runs">
        <p className="m-0 mb-1.5 text-[12px] leading-relaxed" style={{ color: "var(--text2)" }}>{box?.tone === "boxed" ? BOXED_PROCESS_NOTE : PROCESS_WARNING}</p>
        {/* The command, as a command: the one line here that is not prose, and
            the one a reader is most likely to want to recognise. */}
        <code className="block t-mono text-[11.5px] px-2 py-1.5 rounded-md break-all"
          style={{ color: "var(--text)", background: "var(--surface-inset)", border: EDGE }}>
          {plugin.entrypoint}
        </code>
      </Block>

      {d && box && (
        <Block
          icon={<ShieldIcon size={ICON.sm} />}
          tint={box.tone === "warning" ? "var(--error)" : d.secretCount ? "var(--error)" : "var(--warning)"}
          head="What it asks to be given"
          chip={d.secretCount ? `${d.secretCount} look${d.secretCount === 1 ? "s" : ""} like a login` : "declared"}
        >
          <p className="m-0 mb-1.5 text-[12px] leading-relaxed" style={{ color: box.tone === "warning" ? "var(--error)" : "var(--text2)" }}>{box.text}</p>
          {box.tone === "warning" && "fix" in box && box.fix && <FixBlock command={box.fix} />}
          {neighbourKey && <p className="m-0 mb-1.5 text-[12px] leading-relaxed" style={{ color: "var(--error)" }}>{neighbourKey}</p>}
          {box.tone === "boxed" && box.refused && box.refused.length > 0 && (
            <div className="flex flex-col gap-0.5 mb-1.5">
              {box.refused.map((r) => (
                <p key={r.path} className="m-0 text-[11.5px] leading-snug" style={{ color: "var(--error-ink)" }}>
                  Refused <span className="t-mono">{r.path}</span> — {r.why}
                </p>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Row label="Network" tint={d.internet ? "var(--warning)" : undefined}>
              {d.internet ? "any host on the internet" : "this app only"}
            </Row>
            <Grants label="Reads" grants={d.reads} />
            <Grants label="Writes" grants={d.writes} />
            {d.programs.length > 0 && <Row label="Programs">{d.programs.join(", ")}</Row>}
          </div>
        </Block>
      )}

      {drawn.length > 0 && (
        <Block icon={<PuzzleIcon size={ICON.sm} />} tint="var(--primary)" head="Where it draws"
          chip={`${drawn.length} ${drawn.length === 1 ? "place" : "places"}`}>
          <div className="flex flex-col gap-1">
            {drawn.map((s) => (
              <div key={s.what} className="flex items-start gap-2 min-w-0">
                <span className="shrink-0 mt-px" style={{ color: "var(--primary-ink)" }}>{s.icon}</span>
                <span className="min-w-0 text-[12px] leading-snug">
                  <span style={{ color: "var(--text)" }}>{s.what}</span>
                  <span className="t-dim"> — {s.where}</span>
                </span>
              </div>
            ))}
          </div>
        </Block>
      )}
    </div>
  );
}

function Row({ label, tint, children }: { label: string; tint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 min-w-0 text-[12px] leading-snug">
      <span className="shrink-0 w-[68px] t-dim">{label}</span>
      <span className="min-w-0 break-all" style={{ color: tint ?? "var(--text)" }}>{children}</span>
    </div>
  );
}

/** The one-time fix, as a command to run rather than a paragraph to follow:
 *  copied whole, never retyped from a screenshot of a terminal. */
function FixBlock({ command }: { command: string }) {
  return (
    <div className="relative mb-1.5">
      <pre className="m-0 t-mono text-[11px] leading-relaxed px-2 py-1.5 pr-7 rounded-md overflow-x-auto whitespace-pre"
        style={{ color: "var(--text)", background: "var(--surface-inset)", border: EDGE }}>
        {command}
      </pre>
      <button type="button" className="agx-btn absolute top-1 right-1 rounded inline-flex items-center justify-center"
        style={{ width: HIT, height: HIT, color: "var(--text3)" }}
        title="Copy" onClick={() => { void navigator.clipboard?.writeText(command).catch(() => {}); }}>
        <CopyIcon size={ICON.xs} />
      </button>
    </div>
  );
}

/** One line per path, so a red one cannot hide in a comma-separated run. */
function Grants({ label, grants }: { label: string; grants: SandboxGrant[] }) {
  if (grants.length === 0) return null;
  return (
    <Row label={label}>
      <span className="flex flex-col gap-0.5">
        {grants.map((g) => (
          <span key={g.path} className="t-mono text-[11.5px]" style={{ color: g.secret ? "var(--error)" : "var(--text)" }}>
            {g.path}{g.secret && <span className="t-dim" style={{ color: "var(--error-ink)" }}> · {g.secret}</span>}
          </span>
        ))}
      </span>
    </Row>
  );
}

function Block({ icon, tint, head, chip, children }: {
  icon: ReactNode; tint: string; head: string; chip?: string; children: ReactNode;
}) {
  return (
    <section className="rounded-lg px-2.5 py-2 min-w-0" style={{
      background: "color-mix(in srgb, var(--border) 10%, transparent)",
      border: EDGE,
    }}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="shrink-0 flex" style={{ color: tint }}>{icon}</span>
        <span className="text-[10px] uppercase tracking-[.12em]" style={{ color: "var(--text3)" }}>{head}</span>
        {chip && (
          <span className="ml-auto text-[10px] px-1.5 py-px rounded-full whitespace-nowrap"
            style={{ color: tint, background: `color-mix(in srgb, ${tint} 12%, transparent)` }}>{chip}</span>
        )}
      </div>
      {children}
    </section>
  );
}
