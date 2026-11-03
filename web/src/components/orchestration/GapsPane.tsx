/*
 * Screen 7 of the redesign, as a page: what the page before it did not have,
 * the decision behind each trade, and what the page gained. Kept beside the
 * Orchestration page so a person comparing the two reads the list in the same
 * window, and so a control that moves has one place that says where it went.
 */

interface Missed {
  /** What the app had no way to do. */
  missing: string;
  /** What the redesign does about it. */
  redesign: string;
  /** Where, in the redesign's own screens. */
  where: string;
}

/** One decision that removed nothing, and what it means for a person. */
interface Decision { decision: string; detail: string }

/** One thing the redesign adds that the app never had. */
interface Added { added: string; what: string }

export const GAPS_SUB =
  "From the real code and 78 + 29 screenshots of today's app. Corrections to my first mockup: the path has FIVE blocks (not eight) and the team has 14 roles.";

export const GAPS_MISSED: readonly Missed[] = [
  { missing: "Envelope save bar and “Permissions not saved”", redesign: "Kept as in the app: explicit Save, dirty badge in the scope bar and a bottom bar", where: "Screen 1 · flip a safety level" },
  { missing: "“Use the general setting”", redesign: "Button in the scope strip and in the locked banner", where: "Screen 1 · orbit / acme" },
  { missing: "Fallback panel: threshold, engine, go back, on/off", redesign: "Inside Conditions, editable", where: "Screen 4" },
  { missing: "5 trigger kinds and their fields", redesign: "New condition sheet, five kinds", where: "Screen 4 · New condition" },
  { missing: "Rule priority ↑↓, “touches n blocks”, open the block", redesign: "Numbered order, first wins, arrows and chips", where: "Screen 4" },
  { missing: "Per-role chain inside a rule", redesign: "One row per role with its own chain", where: "Screen 4 · New condition" },
  { missing: "“Add a rule for this block” and block rule chips", redesign: "Section “Rules that move it” of the worker editor + “by a rule” chip on the card", where: "Screens 2, 3" },
  { missing: "Team rail: 14 roles, drag to path, “You”", redesign: "Left rail, searchable by eye, on the path / off the path", where: "Screen 2" },
  { missing: "Canvas navigation: minimap, zoom, fit, grid, drag reorder", redesign: "All drawn; drag reorder and arrows kept", where: "Screen 2" },
  { missing: "“+” gap between two blocks", redesign: "Hover between cards", where: "Screen 2" },
  { missing: "Role sheet: exits, rounds, required, chain, 5 tools, reads only, as shipped", redesign: "Sections of the ONE worker editor", where: "Screen 3" },
  { missing: "Add sheet: chain, if it fails, rounds, required, team-only, start from a role", redesign: "Same editor as any worker, in new mode: name, icon, colour, prompt, engine chain, exits, tools, reviewer, place on the path", where: "Screen 5" },
  { missing: "Reviewer: three answers + second reviewer engine/model", redesign: "Section “Who checks this”", where: "Screen 3" },
  { missing: "No-project state, counters, “Saved on your first change”", redesign: "States + honest line of the editor", where: "Screens 2, 6" },
  { missing: "Orchestrator had no settings", redesign: "A big card on the canvas and its own sheet: engine, model, what it does with code, Flight plan mode, the most it may grant", where: "Screen 2 · Configure" },
  { missing: "Rename a worker, change its icon and colour", redesign: "Section “Name and look” first in every worker editor, live in the header and the preview; 26 icons, 10 colours", where: "Screen 3" },
  { missing: "Create a worker with everything a worker has", redesign: "“Add worker” opens the full editor in new mode; “Start from a team role” fills it", where: "Screen 5" },
  { missing: "What a role can never be given", redesign: "Planner, Inspector and Verifier show their fixed limits; Landing shows only what a human block has", where: "Screen 3 · What it may do" },
  { missing: "Always refused: global or per project", redesign: "Two blocks: “Fixed for everyone” (locked) and “Only for orbit” (editable, with Use the general setting)", where: "Screen 1 · Always refused" },
  { missing: "Keys and menus tab", redesign: "Removed: nobody needs a shortcut list as a settings page", where: "Screen 1" },
  { missing: "Settings page shows the real fields", redesign: "Limits (3), When a limit is reached, what a worker may do and the most the main agent may allow, Agents and the Gate", where: "Screen 1 · Safety and limits" },
  { missing: "Fail arrows and pass target on every card", redesign: "Dashed arcs “fails → Builder · up to n tries”, pass/fail row on the card", where: "Screen 2" },
  { missing: "Engine and model on a card", redesign: "Engine avatars with a tooltip carrying the whole route", where: "Screen 2" },
  { missing: "Presets: what each one does", redesign: "Three shipped (Careful, Balanced, Thrifty), fixed, with a details modal: orchestrator, workers, limits, cost", where: "Screen 1 · Presets" },
  { missing: "Your own presets", redesign: "Changing a preset creates “Balanced + N changes”: Save as my preset, Share or Back", where: "Screen 1" },
  { missing: "Share a setup with a friend", redesign: "`.agxpreset` JSON with per-part switches (prompts, safety, team), a preview and a real download; import too", where: "Screen 1 · Share" },
  { missing: "Live count per role", redesign: "“×N” on each role in the Settings hero and “Instances now” in the worker panel", where: "Screens 1, 2" },
  { missing: "Read-only worker detail", redesign: "Panel with stats, instances, recent turns, handoff, engine chain, flow, permissions and prompt; edits only in Configure", where: "Screen 2" },
  { missing: "Name and look when the worker exists", redesign: "Folded row “Rename, icon, colour”; open by default only when adding", where: "Screens 3, 5" },
  { missing: "Workers at once", redesign: "Cap stays at 12; more only through an advanced setting that warns about the machine and the plan", where: "Screen 1 · Limits" },
  { missing: "Extra shell commands, project then worker", redesign: "A “Docker for workers” switch in Safety and limits, off by default and needing your Approve click; each worker then gets its own removable list (docker, make ci-docker) while git push, gh, ssh, sudo and rm stay locked", where: "Screens 1, 3" },
];

export const GAPS_DECISIONS: readonly Decision[] = [
  { decision: "One place to configure a worker", detail: "The right panel stops editing and becomes a read-only summary. The Role and prompt modal becomes the single worker editor. Nothing is lost: every field of both is in it." },
  { decision: "Saving", detail: "Permissions keep their explicit Save. Engine, model, fallbacks, Ask, Required and Reads only keep saving at once. The editor footer says which is which." },
  { decision: "Rules", detail: "Ordered list, first match wins, one chain per role, five trigger kinds." },
];

export const GAPS_ADDED: readonly Added[] = [
  { added: "Flow as a guide, with a reason", what: "When the orchestrator skips or reorders a block it leaves one line, shown on the card and in the Activity log. Never blocks. (row 134)" },
  { added: "Worker card = PR-card family", what: "Verdict strip, progress ring, route with fallback, cells (last, tries, cost), event line, footer with one primary press, kebab menu with every action, hover lights the neighbours. Words decided in a model file, as the PR card does." },
  { added: "Right-click menu on every card", what: "Same pattern as the PR card; an item that is off says why." },
  { added: "Pin a worker", what: "Pin to the bench, as a PR is pinned." },
];

export function GapsPane() {
  return (
    <div className="agx-orch-gaps">
      <h2 className="agx-orch-gaps-t">Gaps found and what is added</h2>
      <p className="agx-orch-gaps-sub">{GAPS_SUB}</p>

      <h3 className="agx-orch-gaps-h" id="agx-orch-gaps-a">A · What the first mockup missed, now drawn</h3>
      <table className="agx-orch-gaps-tb" aria-labelledby="agx-orch-gaps-a">
        <thead>
          <tr><th scope="col">Missing</th><th scope="col">In the redesign</th><th scope="col">Where</th></tr>
        </thead>
        <tbody>
          {GAPS_MISSED.map((r) => (
            <tr key={r.missing}>
              <td data-label="Missing">{r.missing}</td>
              <td data-label="In the redesign">{r.redesign}</td>
              <td data-label="Where"><span className="agx-orch-gaps-chip">{r.where}</span></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="agx-orch-gaps-h" id="agx-orch-gaps-b">B · Decisions (no function removed)</h3>
      <table className="agx-orch-gaps-tb" aria-labelledby="agx-orch-gaps-b">
        <tbody>
          {GAPS_DECISIONS.map((r) => (
            <tr key={r.decision}>
              <td><b>{r.decision}</b></td>
              <td>{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="agx-orch-gaps-h" id="agx-orch-gaps-c">C · Added functionality</h3>
      <table className="agx-orch-gaps-tb" aria-labelledby="agx-orch-gaps-c">
        <tbody>
          {GAPS_ADDED.map((r) => (
            <tr key={r.added}>
              <td><b>{r.added}</b></td>
              <td>{r.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
