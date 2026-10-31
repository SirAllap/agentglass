// The Git header: its decisions as functions, and its drawing as source (there
// is no renderer here, so a rule about the markup is asserted against source).
import { describe, expect, it } from "bun:test";
import { SQUEEZE_MAX, ageText, badgeNotes, nextSqueeze, chipView, disabledReason, fetchEach, fetchedLabel, headerFacts, headerShape, slotItems, splitSlot, stateBanner, upstreamRemote, type HeaderFacts } from "../src/lib/gitHeader.ts";
import { failedRemotes, failKind, fetchCard, pullCard, pushCard, rawLines } from "../src/lib/gitHeaderErrors.ts";

const src = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const header = await src("../src/components/GitHeader.tsx");
const panel = await src("../src/components/GitPanel.tsx");
const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join("\n");

const calm: HeaderFacts = { hasRemote: true, hasUpstream: true, detached: false, ahead: 0, behind: 0, hasPr: false, prsLand: false, prUnknown: false, canSync: false, canUndo: false, bisecting: false };

describe("situational slot", () => {
  it("is empty on a calm branch", () => expect(slotItems(calm)).toEqual([]));
  it("leads with the way out of a dead end", () => {
    expect(slotItems({ ...calm, hasRemote: false })).toEqual(["add-remote"]);
    expect(slotItems({ ...calm, detached: true })).toEqual(["make-branch"]);
    expect(slotItems({ ...calm, detached: true, hasPr: true, canSync: true })[0]).toBe("make-branch");
  });
  it("lists the review before the moves", () => {
    expect(slotItems({ ...calm, hasPr: true, canSync: true, canUndo: true, bisecting: true })).toEqual(["pr", "sync", "undo", "bisect"]);
  });
  it("a PR for this branch hides the 'PRs land here' and 'unknown' chips", () => {
    expect(slotItems({ ...calm, hasPr: true, prsLand: true, prUnknown: true })).toEqual(["pr"]);
    expect(slotItems({ ...calm, prsLand: true, prUnknown: true })).toEqual(["prs-land"]);
  });
  it("shows two and puts the rest behind +N, in order", () => {
    const all = slotItems({ ...calm, hasPr: true, canSync: true, canUndo: true, bisecting: true });
    const { visible, overflow } = splitSlot(all);
    expect(visible).toEqual(["pr", "sync"]);
    expect(overflow).toEqual(["undo", "bisect"]);
    expect(splitSlot(["a"]).overflow).toEqual([]);
  });
  it("reads bisecting off the branch state", () => {
    expect(headerFacts({ upstream: "origin/m", ahead: 0, behind: 0, detached: false, state: "bisecting" }, { hasRemote: true }).bisecting).toBe(true);
    expect(headerFacts(undefined, { hasRemote: false }).hasUpstream).toBe(false);
  });
});

describe("branch chip", () => {
  const b = { name: "main", ahead: 2, behind: 3, upstream: "origin/main", detached: false, state: "clean" as const };
  const label = (s: string) => ({ merging: "merging" } as Record<string, string>)[s] ?? null;
  it("says detached at the short sha", () => {
    const v = chipView({ ...b, name: "(detached)", detached: true, upstream: null }, true, "9f4dec9", label);
    expect(v.text).toBe("detached at 9f4dec9");
    expect(v.sync).toBeNull();
  });
  it("shows the counts only when there is something to compare against", () => {
    expect(chipView(b, true, null, label).sync).toEqual({ ahead: 2, behind: 3, inSync: false });
    expect(chipView(b, false, null, label).sync).toBeNull();
    expect(chipView({ ...b, upstream: null }, true, null, label).sync).toBeNull();
    expect(chipView({ ...b, ahead: 0, behind: 0 }, true, null, label).sync?.inSync).toBe(true);
  });
  it("names the state git is in", () => expect(chipView({ ...b, state: "merging" }, true, null, label).state).toBe("merging"));
});

describe("fetch tooltip", () => {
  const now = 10 * 60_000;
  it("names the remotes and the age, and says nothing new only when nothing was new", () => {
    expect(fetchedLabel({ at: now - 2 * 60_000, remotes: ["origin", "upstream"], news: 0 }, now)).toEqual({ title: "Fetched origin and upstream 2 min ago", sub: "auto-fetch every 60 s · nothing new" });
    expect(fetchedLabel({ at: now - 2 * 60_000, remotes: ["origin"], news: 3 }, now)?.sub).toBeNull();
  });
  it("is omitted when unknown", () => {
    expect(fetchedLabel(null, now)).toBeNull();
    expect(fetchedLabel({ at: now, remotes: [], news: 0 }, now)).toBeNull();
  });
  it("reads ages at the grain a person uses", () => {
    expect(ageText(20_000)).toBe("just now");
    expect(ageText(59 * 60_000)).toBe("59 min ago");
    expect(ageText(3 * 3_600_000)).toBe("3 h ago");
    expect(ageText(2 * 86_400_000)).toBe("2 d ago");
    expect(fetchedLabel({ at: now - 5_000, remotes: ["origin"], news: 0 }, now)?.title).toBe("Fetched origin just now");
  });
});

describe("disabled reasons", () => {
  it("fetch: no remote", () => {
    expect(disabledReason("fetch", { ...calm, hasRemote: false })).toBe("No remote to fetch from");
    expect(disabledReason("fetch", calm)).toBeNull();
  });
  it("pull: no upstream, detached, or no remote", () => {
    expect(disabledReason("pull", { ...calm, hasUpstream: false })).toBe("No upstream to pull from");
    expect(disabledReason("pull", { ...calm, detached: true })).toBe("No upstream to pull from");
    expect(disabledReason("pull", { ...calm, hasRemote: false, hasUpstream: false })).toBe("No upstream to pull from");
    expect(disabledReason("pull", calm)).toBeNull();
  });
  it("push: no remote, or nothing to send; a branch not yet on the remote may publish", () => {
    expect(disabledReason("push", { ...calm, hasRemote: false })).toBe("No remote");
    expect(disabledReason("push", calm)).toBe("Nothing to push");
    expect(disabledReason("push", { ...calm, ahead: 1 })).toBeNull();
    expect(disabledReason("push", { ...calm, hasUpstream: false })).toBeNull();
  });
});

describe("fetch, one remote at a time", () => {
  it("never overlaps two requests and reports each as it returns", async () => {
    let inFlight = 0, peak = 0;
    const log: string[] = [];
    const res = await fetchEach(["origin", "upstream", "mirror"], async (r) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((ok) => setTimeout(ok, 5));
      inFlight--;
      return r === "upstream" ? { ok: false, error: "fatal: Could not read from remote repository." } : { ok: true };
    }, (r, s) => log.push(`${r}:${s}`));
    expect(peak).toBe(1);
    expect(log).toEqual(["origin:run", "origin:ok", "upstream:run", "upstream:fail", "mirror:run", "mirror:ok"]);
    expect(res.map((r) => r.ok)).toEqual([true, false, true]);
  });
  it("a request that throws fails that remote and the next still runs", async () => {
    const res = await fetchEach(["a", "b"], async (r) => { if (r === "a") throw new Error("offline"); return { ok: true }; }, () => {});
    expect(res[0]!.ok).toBe(false);
    expect(res[0]!.error).toContain("offline");
    expect(res[1]!.ok).toBe(true);
  });
  it("with no remote names known it still sends one fetch for all of them", async () => {
    const asked: (string | undefined)[] = [];
    const res = await fetchEach([], async (r) => { asked.push(r); return { ok: false, error: "offline" }; }, () => {});
    expect(asked).toEqual([undefined]);
    expect(res.map((r) => r.ok)).toEqual([false]);
  });
  it("retry covers every failed remote, not the first", () => {
    const c = fetchCard([{ remote: "a", ok: false, error: "x" }, { remote: "b", ok: true }, { remote: "c", ok: false, error: "y" }])!;
    expect(failedRemotes(c)).toEqual(["a", "c"]);
    expect(c.next.label).not.toContain("a again");
    expect(header).toContain("doFetch(failedRemotes(c))");
  });
  it("the sync button is never pushed behind +N", () => {
    expect(splitSlot(["pr", "undo", "sync"], 2, "sync")).toEqual({ visible: ["pr", "sync"], overflow: ["undo"] });
    expect(splitSlot(["pr", "sync", "undo"], 2, "sync").visible).toEqual(["pr", "sync"]);
    expect(code(header)).toContain('shape.slotMax, "sync")');
  });
  it("closing a card clears the red on its button", () => {
    const fn = header.slice(header.indexOf("const closeCard"), header.indexOf("const next ="));
    expect(fn).toContain("setFailed(null)");
  });
  it("overflow and header run handlers keep the buttons' guards; no dead handler", () => {
    expect(panel).toContain("const syncOff = !writeEnabled || busy || !tree?.clean || twinBehind;");
    expect(panel).toContain("const syncRun = () => { if (!syncOff");
    expect(panel).toContain("run: syncRun,");
    expect(panel).toContain("if (!undoOff) void undoMerge()");
    expect(panel).not.toContain("run: () => {}");
  });
  it("names the remote an upstream lives on", () => {
    expect(upstreamRemote("origin/feat/x")).toBe("origin");
    expect(upstreamRemote(null)).toBeNull();
  });
});

describe("error cards", () => {
  const rejected = "To git.acme.dev:orbit/app.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\nhint: Updates were rejected";
  it("a rejected push says what was not sent and offers pull-then-push", () => {
    expect(failKind(rejected)).toBe("rejected");
    const c = pushCard(rejected, { branch: "main", ahead: 2, behind: 1, remote: "origin" });
    expect(c.title).toBe("origin has 1 commit you don't have");
    expect(c.body).toContain("Your 2 commits were not sent");
    expect(pushCard(rejected, { branch: "main", ahead: 1, behind: 1, remote: "origin" }).body).toContain("Your 1 commit was not sent");
    expect(c.next).toEqual({ id: "pull-then-push", label: "Pull, then push" });
    expect(c.raw).not.toContain("hint:");
  });
  it("an unreachable fetch lists every remote and retries the one that failed", () => {
    const c = fetchCard([
      { remote: "origin", ok: true },
      { remote: "upstream", ok: false, error: "ssh: connect to host git.acme.dev port 22: Connection timed out\nfatal: Could not read from remote repository." },
    ])!;
    expect(c.title).toBe("upstream could not be reached");
    expect(c.rows).toEqual([{ remote: "origin", ok: true, note: "fetched" }, { remote: "upstream", ok: false, note: "no answer from the host" }]);
    expect(c.next.label).toBe("Try upstream again");
    expect(fetchCard([{ remote: "origin", ok: true }])).toBeNull();
  });
  it("a diverged pull explains itself and offers no button that would not work", () => {
    const c = pullCard("fatal: Not possible to fast-forward, aborting.", { branch: "main", upstream: "origin/main" });
    expect(failKind("fatal: Not possible to fast-forward, aborting.")).toBe("diverged");
    expect(c.title).toBe("main and origin/main have diverged");
    expect(c.next.id).toBe("none");
  });
  it("uncommitted work in the way is its own card", () => {
    expect(pullCard("error: Your local changes to the following files would be overwritten by merge:\n\ta.ts", { branch: "main", upstream: null }).title).toBe("Your changes are in the way");
  });
  it("an authentication refusal points at Remotes", () => {
    expect(pushCard("git@git.acme.dev: Permission denied (publickey).", { branch: "main", ahead: 1, behind: 0, remote: "origin" }).next.id).toBe("open-remotes");
  });
  it("unknown text still gets a card, with git's own lines and a retry", () => {
    const c = pushCard("something odd\nsecond", { branch: "main", ahead: 1, behind: 0, remote: "origin" });
    expect(c.title).toBe("The push did not go through");
    expect(c.raw).toBe("something odd\nsecond");
    expect(c.next.id).toBe("retry");
  });
  it("keeps the raw block short", () => expect(rawLines(Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n")).split("\n")).toHaveLength(4));
});

describe("the header's drawing, as source", () => {
  const controls = ["insights", "chip", "fetch", "pull", "push", "refresh", "slot-more", "add-remote", "make-branch"];
  for (const id of controls) {
    it(`control ${id} exists and is wired`, () => {
      const at = header.indexOf(`data-control="${id}"`);
      expect(at).toBeGreaterThan(-1);
      if (id === "refresh") return; // the panel's own RefreshButton lives inside this wrapper
      const tag = header.slice(header.lastIndexOf("<", at), header.indexOf(">", header.indexOf("onClick", at)));
      expect(tag).toContain("onClick");
    });
  }
  it("each remote control says why it is off", () => {
    for (const op of ["fetch", "pull", "push"]) expect(header).toContain(`disabled={off("${op}")}`);
    expect(header).toContain("reasons.fetch ??");
    expect(header).toContain("reasons.pull ??");
    expect(header).toContain("reasons.push ??");
  });
  it("insights is icon-only with a name", () => expect(header).toContain('aria-label="Insights" title="Insights"'));
  it("fetch walks the remotes one by one", () => expect(code(header)).toContain("fetchEach("));
  it("pull-then-push runs pull and then push", () => {
    const body = header.slice(header.indexOf("const doPull ="), header.indexOf("const doPush ="));
    expect(body.indexOf("api.gitPull")).toBeGreaterThan(-1);
    expect(body.indexOf("api.gitPush")).toBeGreaterThan(body.indexOf("api.gitPull"));
    expect(body).toContain("if (!r.ok)");
  });
  it("a failed fetch, pull or push never reaches the toast", () => {
    expect(code(header)).not.toMatch(/flash\(false/);
    const mount = panel.slice(panel.indexOf("<GitHeader"), panel.indexOf("onMakeBranch={makeBranchHere}"));
    expect(mount.length).toBeGreaterThan(200);
    expect(mount).not.toMatch(/api\.git(Fetch|Pull|Push)|\bact\(/);
  });
  it("the card closes on Escape and outside press (AnchoredMenu) and keeps its text in the command log", () => {
    expect(header).toContain("<AnchoredMenu anchor={card.op ===");
    expect(header).toContain("onClose={closeCard}");
    expect(header).toContain("onOpenLog()");
  });
  it("every control is 26 high and 7 round, and push is dark", () => {
    expect(header).toContain("h-[26px]");
    expect(header).toContain("borderRadius: 7");
    expect(header).toContain('tone === "dark" ? { background: "var(--text)", color: "var(--bg)"');
    expect(header).toContain('facts.ahead > 0 || (!facts.hasUpstream && !off("push")) ? "dark"');
  });
  it("the tab strip scrolls and fades at the right edge only while clipped", () => {
    expect(header).toContain("overflow-x-auto");
    expect(header).toContain("maskImage: fade");
    expect(header).toContain("clipped ?");
  });
  it("the slot is capped at 40% and two items", () => {
    expect(header).toContain('maxWidth: "40%"');
    expect(header).toContain("splitSlot(");
  });
  it("the panel hands the header over instead of drawing it", () => {
    expect(panel).toContain("<GitHeader");
    expect(panel).not.toContain("function RemoteButton(");
    expect(panel).not.toContain("function BranchChip(");
    expect(panel).not.toContain("<RemoteButton");
  });
});

describe("header layout and progress source rules", async () => {
  const header = await src("../src/components/GitHeader.tsx");
  it("lists every remote as waiting before the first one answers", () => {
    expect(header).toContain('names.map((remote) => ({ remote, state: "wait" as const }))');
  });
  it("lets the tab strip yield, so the slot and the right cluster are never the ones squeezed", () => {
    expect(header).toMatch(/data-tabs-strip/);
    expect(header).toContain("min-w-[96px] flex-1 overflow-x-auto");
    expect(header).toContain('className="flex items-center gap-1.5 shrink-0 overflow-hidden" style={{ maxWidth: "40%" }} data-slot');
  });
  it("cuts a long publish target instead of pushing the refresh button off the window", () => {
    expect(header).toContain('className="truncate max-w-[22ch]"');
  });
});

describe("a stopped repository keeps its banner", () => {
  it("says what is in progress, with the conflict count, for every state git stops in", () => {
    expect(stateBanner("merging", 2)?.text).toBe("Merge in progress — 2 conflicted files");
    expect(stateBanner("merging", 1)?.text).toBe("Merge in progress — 1 conflicted file");
    expect(stateBanner("rebasing", 0)?.text).toBe("Rebase in progress — 0 conflicted files");
    expect(stateBanner("cherry-picking", 0)?.text).toContain("Cherry-pick in progress");
    expect(stateBanner("reverting", 0)?.text).toContain("Revert in progress");
  });
  it("names no count and cannot continue until the conflict list has been read", () => {
    expect(stateBanner("merging", null)).toMatchObject({ text: "Merge in progress", canContinue: true, continueWhy: "reading the conflicts…" });
    expect(code(panel)).toContain("conflicts={conflictsLoaded ? conflicts.length : null}");
    expect(code(panel)).toContain("setConflictsLoaded(true)");
    expect(code(panel)).toContain("setConflictsLoaded(false)");
  });
  it("ends a bisect without the discard-your-resolutions question", () => {
    const c = code(panel);
    const abort = c.slice(c.indexOf("const abortMerge = async"), c.indexOf("const restoreSnapshot"));
    expect(abort.indexOf('mergeState === "bisecting"')).toBeGreaterThan(-1);
    expect(abort.indexOf('"Bisect ended"')).toBeLessThan(abort.indexOf("Abort and discard"));
  });
  it("draws nothing for a clean or unknown tree", () => {
    expect(stateBanner("clean", 0)).toBeNull();
    expect(stateBanner(undefined, 0)).toBeNull();
  });
  it("continues only a merge with no conflict left; a bisect has nothing to continue", () => {
    expect(stateBanner("merging", 3)).toMatchObject({ canContinue: true, continueWhy: "resolve every file first" });
    expect(stateBanner("merging", 0)).toMatchObject({ canContinue: true, continueWhy: null });
    expect(stateBanner("bisecting", 0)).toMatchObject({ text: "Bisect in progress", canContinue: false });
  });
  it("is drawn on the conflict screen too, which replaces the header", () => {
    const c = code(panel);
    const conflictBranch = c.slice(c.indexOf("{inConflict ? ("), c.indexOf("<GitHeader"));
    expect(conflictBranch).toContain("{stateBanner}");
    expect(c.slice(c.indexOf("<GitHeader"))).toContain("{stateBanner}");
    expect(c).toContain("onAbort={abortMerge}");
    expect(c).toContain("api.gitMergeContinue(root)");
  });
});

describe("the row fits a 1000 px window with bisect, a detached HEAD and no remote", () => {
  const facts = headerFacts({ upstream: null, ahead: 0, behind: 0, detached: true, state: "bisecting" }, { hasRemote: false });
  const all = slotItems(facts);
  it("has three situational items and both dashed badges to start with", () => {
    expect(all).toEqual(["add-remote", "make-branch", "bisect"]);
    expect(headerShape(0)).toEqual({ badges: true, slotMax: 2, chipState: true });
  });
  it("gives up the badges first, then slot items one at a time, then the chip state", () => {
    expect(headerShape(1)).toEqual({ badges: false, slotMax: 2, chipState: true });
    expect(headerShape(2)).toEqual({ badges: false, slotMax: 1, chipState: true });
    expect(headerShape(3)).toEqual({ badges: false, slotMax: 0, chipState: true });
    expect(headerShape(SQUEEZE_MAX)).toEqual({ badges: false, slotMax: 0, chipState: false });
  });
  it("puts every item behind +N at the last slot step, so the row holds one button for them", () => {
    expect(splitSlot(all, headerShape(3).slotMax, "sync")).toEqual({ visible: [], overflow: all });
    expect(splitSlot(all, headerShape(2).slotMax, "sync")).toEqual({ visible: ["add-remote"], overflow: ["make-branch", "bisect"] });
  });
  it("never puts the sync button, which carries the base picker, behind +N", () => {
    const withSync = slotItems({ ...facts, canSync: true });
    expect(splitSlot(withSync, 0, "sync").visible).toEqual(["sync"]);
    expect(splitSlot(withSync, 1, "sync").visible).toEqual(["sync"]);
  });
  it("steps down one level while the row overflows, and stops at the last", () => {
    expect(nextSqueeze(true, 0, false)).toBe(1);
    expect(nextSqueeze(true, SQUEEZE_MAX - 1, false)).toBe(SQUEEZE_MAX);
    expect(nextSqueeze(true, SQUEEZE_MAX, false)).toBe(SQUEEZE_MAX);
    expect(nextSqueeze(false, 3, false)).toBe(3);
  });
  it("starts again from everything when the inputs changed, without trusting the old measurement", () => {
    expect(nextSqueeze(true, 3, true)).toBe(0);
    expect(nextSqueeze(false, 3, true)).toBe(0);
    // Already at everything: the render IS the new evidence, so it is measured.
    expect(nextSqueeze(true, 0, true)).toBe(1);
    expect(nextSqueeze(false, 0, true)).toBe(0);
  });
  it("reaches a fixed point: a fitting row asks for no further change", () => {
    let s = 0; let widthLeft = 3; // overflow for the first three shapes, then it fits
    for (let i = 0; i < 20; i++) { const n = nextSqueeze(widthLeft-- > 0, s, false); if (n === s) break; s = n; }
    expect(s).toBe(3);
  });
  it("draws what the shape asks for, and runs the fit once per change of squeeze or inputs", () => {
    const c = code(header);
    expect(c).toContain("nextSqueeze(el.scrollWidth > el.clientWidth + 1, squeeze, justReset)");
    expect(c).toContain("}, [squeeze, fitKey]);");
    expect(c).toContain('splitSlot(slotItems(facts).filter((id) => entries[id]), shape.slotMax, "sync")');
    expect(c).toContain("shape.badges && notes.map");
    expect(c).toContain("chip.state && shape.chipState");
    for (const k of ["pickerW", "running", "pushLabel", "treeStale"]) expect(c.match(/const fitKey = .*/)![0]).toContain(`\${${k}}`);
  });
  it("keeps what the badges said reachable once they are gone", () => {
    expect(badgeNotes({ hasRemote: false, hasUpstream: false, detached: true })).toEqual([{ label: "no remote", text: expect.stringContaining("no remote yet") }]);
    expect(badgeNotes({ hasRemote: true, hasUpstream: false, detached: false })).toEqual([{ label: "no upstream", text: "Nothing to compare against" }]);
    expect(badgeNotes({ hasRemote: true, hasUpstream: false, detached: true })).toEqual([]);
    expect(badgeNotes({ hasRemote: true, hasUpstream: true, detached: false })).toEqual([]);
    expect(code(header)).toContain('(shape.badges ? "" : notes.map((n) => `\\n${n.text}`).join(""))');
  });
});
