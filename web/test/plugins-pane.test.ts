/*
 * The Plugins page, and the one thing it exists to make unmissable.
 *
 * A plugin whose manifest changed since it was approved must read as "this
 * is asking for something different now", never as an ordinary disabled
 * row — that is the whole trust model this page sits on top of. And the
 * `read` scope has to say plainly that it sees a session's live output, not
 * just the bare word "read": see server/src/index.ts's own description of
 * /stream carrying "the whole fleet's prompts, paths and errors".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pinnedByMarket } from "../src/components/PluginsPane.tsx";

const pane = readFileSync(new URL("../src/components/PluginsPane.tsx", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
/** The declaration a person approves moved out of the card into its own
 *  component, drawn in both the card and the dialog that asks. The sentences
 *  are held to the same rule wherever they live. */
const declaration = readFileSync(new URL("../src/components/plugins/PluginDeclaration.tsx", import.meta.url), "utf8");

describe("re-consent reads as its own thing", () => {
  test("distinct from a plugin that has simply never been reviewed", () => {
    // hadApproval is what tells the two apart — see server/src/plugins.ts.
    expect(pane).toContain("plugin.approvedFingerprint !== plugin.fingerprint");
    expect(pane).toContain("needsReview && plugin.hadApproval");
    expect(pane).toMatch(/asking for something different now/);
    expect(pane).toMatch(/Not reviewed yet/);
  });

  test("its own warning colour, not the ordinary disabled styling", () => {
    expect(pane).toMatch(/reconsent && manifestChanged && \(/);
    expect(pane).toContain('<Note tone="warn">');
    expect(pane).toMatch(/"Asks again", "warn"/);
  });
});

describe("a re-consent that only re-hashed the code doesn't claim the manifest moved", () => {
  test("manifestHash vs approvedHash decides which of the two boxes shows", () => {
    // fingerprint (what gates needsReview/reconsent) folds in every byte on
    // disk, so a README fix or a typo fix re-asks with nothing different in
    // the declaration. manifestHash is the capability-only half of the same
    // record, and comparing it to approvedHash is what tells the two apart.
    expect(pane).toContain("plugin.approvedHash !== null && plugin.approvedHash !== plugin.manifestHash");
    expect(pane).toMatch(/reconsent && manifestChanged && \(/);
    expect(pane).toMatch(/reconsent && !manifestChanged && \(/);
    expect(pane).toMatch(/the manifest changed since then/);
    expect(pane).toMatch(/code changed since you approved it/);
  });
});

describe("the scope sentence is honest about `read`", () => {
  test("says a plugin can see a session's live output, not just \"read\"", () => {
    expect(declaration).toMatch(/every session's live output as it streams/);
    expect(declaration).toMatch(/the same prompts and replies you watch on screen/);
  });

  test("and says what it cannot do through the app, not on the machine", () => {
    expect(declaration).toMatch(/through this app it can only look: no gate, no reply, no writes/i);
  });
});

describe("a switch on with nothing running is the failure this page catches", () => {
  test("the dot and the running line are driven by the PROCESS, not the enabled flag", () => {
    expect(pane).toContain("const running = plugin.running;");
    /* The sentence is shorter than it was — it is a chip on a card now rather
       than a clause in a line of prose — so this matches the two words that
       carry the meaning instead of the whole phrase. What it is guarding has
       not changed: the page must be able to say "you switched it on and
       nothing is running", which is the failure a plugin screen exists to
       show and the one an `enabled` flag alone cannot. */
    expect(pane).toMatch(/Enabled, not running/);
    expect(pane).toContain("pid ${pid}");
  });
});

describe("what every row shows", () => {
  test("name, publisher, description, source, and the scope word", () => {
    expect(pane).toContain("{plugin.name}");
    expect(pane).toContain("by {plugin.publisher}");
    expect(pane).toContain("{plugin.description}");
    expect(pane).toContain("formatSource(plugin.source)");
    expect(pane).toContain("SCOPE_WORD[plugin.scope]");
  });
});

describe("the master switch actually stops things", () => {
  test("turning it off is described as stopping every enabled plugin immediately", () => {
    expect(pane).toMatch(/Turning this off stops every one of them immediately/);
  });
});

describe("install takes a local path or a git URL, and cannot enable an unreviewed plugin", () => {
  test("one field, not a toggle between two modes", () => {
    expect(pane).toMatch(/A local folder's absolute path, or a git URL/);
  });

  test("switching on an unreviewed plugin asks first, and only the master switch locks it", () => {
    // Switching it on is the approval (enablePlugin records it). Locking the
    // switch until something was approved left a new plugin that could never
    // be turned on; it asks instead, with what is being approved.
    expect(pane).toContain("disabled={busy || (!plugin.enabled && !masterOn)}");
    expect(pane).toMatch(/if \(next && needsReview\) \{\s*const ok = await ask\(/);
    expect(pane).toContain("if (!ok) return;");
  });
});

describe("a plugin that grows does not drag its neighbour with it", () => {
  test("installed plugins are a grid of cards, and the permissions fold keeps a card's height from depending on its neighbour", () => {
    // Opening one tile's declaration used to make the tile BESIDE it grow to
    // match, into a tall box with nothing in the bottom two thirds. The
    // declaration is folded by default and the footer is pinned to the bottom
    // (mt-auto), so a row of cards ends on one line whether or not one is open.
    expect(pane).toContain('className="agx-plugin-grid"');
    expect(pane).toContain('className="mt-auto flex items-center');
    expect(pane).not.toContain("gridTemplateColumns");
    // 440 and not wider: every card opens on a 16:9 picture, and in one column
    // of a 1065px page that picture alone was 600px tall.
    expect(CSS).toMatch(/\.agx-plugin-grid \{[^}]*minmax\(min\(440px, 100%\), 1fr\)/);
  });
});

describe("a pinned install says how it updates", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const code = pane.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  test("a market install at a commit is pinned; anything else is not", () => {
    const at = (ref: string | null) => ({ kind: "marketplace" as const, marketplace: { url: "https://example.com/p.json", ref: null, resolvedCommit: ref }, plugin: { url: "https://github.com/acme/orbit", ref } });
    expect(pinnedByMarket(at(SHA))).toBe(SHA);
    expect(pinnedByMarket(at("main"))).toBeNull();
    expect(pinnedByMarket(at(null))).toBeNull();
    expect(pinnedByMarket({ kind: "git", url: "https://github.com/acme/orbit", ref: SHA })).toBeNull();
    expect(pinnedByMarket({ kind: "local-path", path: "/x" })).toBeNull();
  });

  test("its card keeps Update, which reads the market again, and says so", () => {
    // The server re-reads the catalogue for a market install, so Update is no
    // longer a re-fetch of the same commit and the card no longer hides it.
    expect(code).toContain('const updatable = plugin.source.kind !== "local-path";');
    expect(pane).toMatch(/Pinned to .* by the market/);
    expect(pane).toContain("Update reads the market");
  });
});

describe("removing a plugin keeps what was typed into its settings", () => {
  test("the remove confirmation offers to drop the settings, and does not by default", () => {
    // Uninstalling to reinstall a fresh copy used to reset a settings page a
    // person had filled in. The server now keeps them unless told otherwise;
    // this is the one place a person tells it otherwise.
    const remove = pane.slice(pane.indexOf("const remove = async () => {"));
    expect(remove.slice(0, remove.indexOf("};"))).toContain("api.pluginRemove(plugin.name, dropSettings)");
    expect(pane).toContain("const [dropSettings, setDropSettings] = useState(false);");
    expect(pane).toMatch(/\{confirmRemove && hasSettings && \(/);
    expect(pane).toContain("Also remove its settings");
  });

  test("the confirmation says the settings stay behind when the box is left clear", () => {
    // After a Remove there is no card left, so nothing on screen shows that
    // plugins.json still holds what was typed — possibly a token. The default
    // is only not a surprise if the dialog says so before the click.
    const label = pane.slice(pane.indexOf("{confirmRemove && hasSettings && ("));
    expect(label.slice(0, label.indexOf("</label>"))).toContain("kept on this machine for a reinstall");
  });
});

describe("the declaration is a named disclosure inside the plugin's row", () => {
  test("it opens by default only while there is a decision to make, and draws no box of its own", () => {
    // A fresh install or a changed manifest is a decision; once approved,
    // showing the declaration on every visit is noise. Inside a row the blocks
    // are flat: the row is already the frame, and a box that holds boxes is the
    // defect the settings sweep counts.
    expect(pane).toContain('<details className="agx-perm ');
    expect(pane).toContain("<PluginDeclaration plugin={plugin} flat />");
  });
});
