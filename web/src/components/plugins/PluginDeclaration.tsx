import type { ReactNode } from "react";
import type { DeviceScope, PublicPlugin } from "../../../../shared/types.ts";
import { EyeIcon, NoteIcon, HandIcon } from "../../lib/glyphIcons.tsx";
import { CommandIcon, PuzzleIcon, ShieldIcon, SlidersIcon } from "../settingsNavIcons.tsx";
import { describeSandbox, type SandboxGrant } from "../../../../shared/pluginSandbox.ts";
import { ICON } from "../../lib/iconSize.ts";

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

/** Whatever the scope: it limits the token, and the process is the user's. */
const PROCESS_WARNING = "This plugin runs as you. The scope limits its access to this app, not to your machine: it can still read your files and run programs. Approve it only if you would run its code yourself.";

/** The block is a request for a box, and no box is built yet: saying otherwise would be the gate lying. */
const SANDBOX_NOTE = "Declared, not enforced: this version does not build the box yet, so the plugin still runs as you. The list is what a later version will hold it to.";

const SCOPE_WORD: Record<DeviceScope, string> = { read: "reads the app", answer: "reads and replies", full: "everything" };
const SCOPE_TINT: Record<DeviceScope, string> = { read: "var(--success)", answer: "var(--warning)", full: "var(--error)" };

/** One surface, as the person will meet it: a mark, what it is, and where. */
type Surface = { icon: ReactNode; what: string; where: string };

export function surfaces(p: PublicPlugin): Surface[] {
  const c = p.contributes ?? {};
  const out: Surface[] = [];
  for (const panel of c.panels ?? []) {
    out.push({ icon: <PuzzleIcon size={ICON.sm} />, what: `Panel · ${panel.title}`, where: "in the Plugins view" });
  }
  if (c.settings?.length) {
    out.push({
      icon: <SlidersIcon size={ICON.sm} />,
      what: `Settings page · ${c.settings.length} ${c.settings.length === 1 ? "field" : "fields"}`,
      where: "in this window, filled in by you",
    });
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
  return (
    <div className="flex flex-col gap-2.5 min-w-0">
      <Block icon={<EyeIcon size={ICON.sm} />} tint={tint} head="What it sees" chip={SCOPE_WORD[plugin.scope]}>
        <p className="m-0 text-[12px] leading-relaxed" style={{ color: "var(--text2)" }}>{SCOPE_SENTENCE[plugin.scope]}</p>
      </Block>

      <Block icon={<CommandIcon size={ICON.sm} />} tint="var(--warning)" head="What it runs">
        <p className="m-0 mb-1.5 text-[12px] leading-relaxed" style={{ color: "var(--text2)" }}>{PROCESS_WARNING}</p>
        {/* The command, as a command: the one line here that is not prose, and
            the one a reader is most likely to want to recognise. */}
        <code className="block t-mono text-[11.5px] px-2 py-1.5 rounded-md break-all"
          style={{ color: "var(--text)", background: "var(--surface-inset)", border: "1px solid var(--surface-line)" }}>
          {plugin.entrypoint}
        </code>
      </Block>

      {d && (
        <Block icon={<ShieldIcon size={ICON.sm} />} tint={d.secretCount ? "var(--error)" : "var(--warning)"} head="What it asks to be given"
          chip={d.secretCount ? `${d.secretCount} look${d.secretCount === 1 ? "s" : ""} like a login` : "declared"}>
          <p className="m-0 mb-1.5 text-[12px] leading-relaxed" style={{ color: "var(--text2)" }}>{SANDBOX_NOTE}</p>
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
                <span className="shrink-0 mt-px" style={{ color: "var(--primary)" }}>{s.icon}</span>
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

/** One line per path, so a red one cannot hide in a comma-separated run. */
function Grants({ label, grants }: { label: string; grants: SandboxGrant[] }) {
  if (grants.length === 0) return null;
  return (
    <Row label={label}>
      <span className="flex flex-col gap-0.5">
        {grants.map((g) => (
          <span key={g.path} className="t-mono text-[11.5px]" style={{ color: g.secret ? "var(--error)" : "var(--text)" }}>
            {g.path}{g.secret && <span className="t-dim" style={{ color: "var(--error)" }}> · {g.secret}</span>}
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
      border: "1px solid color-mix(in srgb, var(--border) 34%, transparent)",
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
