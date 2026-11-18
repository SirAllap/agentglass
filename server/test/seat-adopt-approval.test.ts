/*
 * Adopting a chair is the person's click.
 *
 * A session's shell holds the machine token — every agent on this machine has
 * it — so POST /seat/adopt used to be enough for any of them to claim a
 * project's chair, and the chair is what may edit that project's flow. These
 * are the routes a session and the person actually call: the agent's attempt
 * becomes one card and writes nothing; the held chair refuses a second pane;
 * the pane the row already holds takes its credential back without asking,
 * without killing the one the occupant is using; and a tab re-linked by its
 * window name does not inherit that allowance.
 *
 * On a server with no desk key held the CLI's own Origin is not the person
 * either: every adoption there is a card, and `agentglass-agent adopt` waits
 * for `adoptedApproved` instead of reading "the row names my pane" as yes. The
 * card is answered by the desk key or a paired phone and never by the Origin of
 * the agent that asked, so nobody can adopt a chair unattended; and a card the
 * person declined ends the CLI's wait at once instead of at the deadline.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
const CLI = new URL("../../bin/agentglass-agent", import.meta.url).pathname;
let h: Harness;
beforeAll(async () => { if (have) h = await startHarness("adopt-approval"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

/** The machine token with no Origin: what a session's own shell sends. */
const asAgent = (path: string, body: unknown) => h.post(path, body, MACHINE, { Origin: "" });
const chair = async () => (await h.read(`/seat?root=${encodeURIComponent(h.dir)}`, MACHINE)).body as any;
const requests = async () => (await (await fetch(`${h.base}/settings/requests`, {
  headers: { Authorization: `Bearer ${MACHINE}`, Origin: h.base },
})).json() as { requests: { id: string; setting: string; diff: string[] }[] }).requests;
/** The person's answer: the app's desk key, claimed for as long as it takes to
 *  answer, because on a server holding no desk an Origin is not a person. */
const decide = async (id: string, approve: boolean) => {
  const release = await h.holdDesk();
  try { return await h.post("/settings/requests/decide", { id, approve }, MACHINE, { "x-agentglass-desk": h.deskKey }); }
  finally { release(); }
};
const until = async <T,>(f: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(100);
  }
};

describe.skipIf(!have)("adopting a chair, by the routes", () => {
  test("an agent's claim is one card, writes nothing, and the person's approval is what adopts it", async () => {
    await h.asPerson("/seat/close", { root: h.dir });
    const pane = await h.handTab(h.dir);

    const asked = await asAgent("/seat/adopt", { root: h.dir, session: "s-agent", pane, powers: "assign" });
    expect(asked.status).toBe(202);
    expect(asked.ok).toBe(true);
    expect((asked as any).applied).toBe(false);
    expect((asked as any).pending.setting).toBe("seat.adopt");
    expect((asked as any).pending.diff.join("\n")).toContain(pane);
    expect((await chair()).seat?.adoptedPane ?? "").toBe("");
    expect((await chair()).seat?.adoptedApproved ?? false).toBe(false);
    expect((await chair()).live).toBe(false);

    /* Its own card is not its to answer. */
    expect((await asAgent("/settings/requests/decide", { id: (asked as any).pending.id, approve: true })).status).toBe(403);
    expect((await chair()).seat?.adoptedPane ?? "").toBe("");

    const card = (await requests()).find((c) => c.setting === "seat.adopt" && c.diff.join("\n").includes(pane));
    expect(card!.setting).toBe("seat.adopt");
    expect((await decide(card!.id, true)).status).toBe(200);
    expect((await chair()).seat?.adoptedPane).toBe(pane);
    expect((await chair()).seat?.adoptedApproved).toBe(true);
    expect((await chair()).live).toBe(true);

    /* The chair is now this pane: it takes its credential back and can be
       called, and the powers on the row are not the caller's to raise. */
    const again = await asAgent("/seat/adopt", { root: h.dir, pane, powers: "speak" });
    expect(again.status).toBe(200);
    expect((again as any).already).toBe(true);
    expect((again as any).token).toMatch(/^st_/);
    expect((again as any).seat.powers).toBe("assign");
    await h.asPerson("/seat/close", { root: h.dir });
    await h.closeTab(pane);
  }, 30_000);

  test("on a server with no desk held, the agent that asked cannot answer its own card", async () => {
    await h.asPerson("/seat/close", { root: h.dir });
    const pane = await h.handTab(h.dir);
    const asked = await asAgent("/seat/adopt", { root: h.dir, session: "s-self-approve", pane, powers: "assign" });
    const id = (asked as any).pending.id;

    /* The machine token and this server's own Origin: exactly what an agent's
       shell can send, and what used to be the person on a server with no desk. */
    const yes = await h.post("/settings/requests/decide", { id, approve: true }, MACHINE);
    expect(yes.status).toBe(403);
    expect(String(yes.error)).toContain("desk key");
    expect((await chair()).seat?.adoptedPane ?? "").toBe("");
    expect((await chair()).seat?.adoptedApproved ?? false).toBe(false);
    expect((await chair()).live).toBe(false);

    /* The card is still waiting for the person, so nothing was answered. */
    expect((await requests()).some((c) => c.id === id)).toBe(true);
    expect((await decide(id, false)).status).toBe(200);
    await h.closeTab(pane);
  }, 30_000);

  test("with the app's desk held, its key answers the card and an Origin still does not", async () => {
    await h.asPerson("/seat/close", { root: h.dir });
    const pane = await h.handTab(h.dir);
    const asked = await asAgent("/seat/adopt", { root: h.dir, session: "s-desk-key", pane, powers: "assign" });
    const id = (asked as any).pending.id;

    const release = await h.holdDesk();
    try {
      expect((await h.post("/settings/requests/decide", { id, approve: true }, MACHINE)).status).toBe(403);
      const yes = await h.post("/settings/requests/decide", { id, approve: true }, MACHINE, { "x-agentglass-desk": h.deskKey });
      expect(yes.status).toBe(200);
      expect((yes as any).applied).toBe(true);
    } finally { release(); }

    expect((await chair()).seat?.adoptedPane).toBe(pane);
    expect((await chair()).seat?.adoptedApproved).toBe(true);
    await h.asPerson("/seat/close", { root: h.dir });
    await h.closeTab(pane);
  }, 30_000);

  test("a second claimant on a held chair is refused, and the occupant stays", async () => {
    await h.asPerson("/seat/close", { root: h.dir });
    const mine = await h.handTab(h.dir, "Orchestrator-orbit");
    expect((await h.adoptAsPerson({ root: h.dir, pane: mine, powers: "speak" })).ok).toBe(true);
    const other = await h.handTab(h.dir);
    expect(other).not.toBe(mine);

    const r = await asAgent("/seat/adopt", { root: h.dir, pane: other, powers: "assign" });
    expect(r.status).toBe(400);
    expect(r.error).toContain("is already in this project's chair");
    expect((await chair()).seat.adoptedPane).toBe(mine);
    await h.asPerson("/seat/close", { root: h.dir });
    await h.closeTab(mine);
    await h.closeTab(other);
  }, 30_000);

  test("a tab re-linked by its window name still asks before it carries the chair's credential", async () => {
    await h.asPerson("/seat/close", { root: h.dir });
    /* A tab elsewhere keeps the tmux server (and its pane numbering) alive. */
    await h.handTab(tmpdir(), "elsewhere");
    const old = await h.handTab(h.dir, "Orchestrator-orbit");
    expect((await h.adoptAsPerson({ root: h.dir, pane: old, powers: "assign" })).ok).toBe(true);

    /* The relay: the window goes and a new one with the seat's name takes
       over. seated() re-links the row to it, but a name is not an approval. */
    await h.closeTab(old);
    const fresh = await h.handTab(h.dir, "Orchestrator-orbit");
    for (let i = 0; i < 40 && (await chair()).agent?.paneId !== fresh; i++) await Bun.sleep(100);
    expect((await chair()).agent?.paneId).toBe(fresh);
    expect((await chair()).seat?.adoptedPane).toBe(fresh);
    expect((await chair()).seat?.adoptedApproved).toBe(false);

    const r = await asAgent("/seat/adopt", { root: h.dir, pane: fresh, powers: "assign" });
    expect(r.status).toBe(202);
    expect((await decide((r as any).pending.id, false)).status).toBe(200);
    await h.asPerson("/seat/close", { root: h.dir });
    await h.closeTab(fresh);
  }, 30_000);

  test("a re-attach does not revoke the credential the occupant is already using", async () => {
    await h.asPerson("/seat/close", { root: h.dir });
    const pane = await h.handTab(h.dir);
    expect((await h.adoptAsPerson({ root: h.dir, pane, powers: "speak" })).ok).toBe(true);

    const first = await asAgent("/seat/adopt", { root: h.dir, pane });
    const second = await asAgent("/seat/adopt", { root: h.dir, pane });
    const third = await asAgent("/seat/adopt", { root: h.dir, pane });
    expect((first as any).token).toMatch(/^st_/);
    expect((second as any).token).toMatch(/^st_/);
    expect((third as any).token).toMatch(/^st_/);
    /* None of them was revoked: a re-attach adds a credential and takes none
       back, so all three answer until the chair is stood down. */
    for (const t of [first, second, third]) {
      expect((await h.read(`/seat/field?root=${encodeURIComponent(h.dir)}&format=json`, (t as any).token)).status).toBe(200);
    }
    await h.asPerson("/seat/close", { root: h.dir });
    await h.closeTab(pane);
  }, 30_000);

  test("on a server with no desk key, the CLI's own Origin is not the person", async () => {
    await h.asPerson("/seat/close", { root: h.dir });
    const pane = await h.handTab(h.dir);

    /* `call()` in bin/agentglass-agent sends exactly this: the machine token
       and Origin: SERVER. A trusted Origin was "the person" on a desk-less
       server, so this POST used to mint the chair's credential with no card. */
    const r = await h.post("/seat/adopt", { root: h.dir, session: "s-cli-origin", pane, powers: "assign" }, MACHINE);
    expect(r.status).toBe(202);
    expect((r as any).applied).toBe(false);
    expect((r as any).token).toBeUndefined();
    expect((await chair()).seat?.adoptedPane ?? "").toBe("");
    expect((await decide((r as any).pending.id, false)).status).toBe(200);
    await h.closeTab(pane);
  }, 30_000);

  test("the CLI waits for the click when the row already names its pane, and never reports failure first", async () => {
    await h.asPerson("/seat/close", { root: h.dir });
    await h.handTab(tmpdir(), "elsewhere");
    const old = await h.handTab(h.dir, "Orchestrator-orbit");
    expect((await h.adoptAsPerson({ root: h.dir, pane: old, powers: "assign" })).ok).toBe(true);

    /* The relay: seated() re-links the row to the fresh pane with no click. */
    await h.closeTab(old);
    const fresh = await h.handTab(h.dir, "Orchestrator-orbit");
    await until(async () => (await chair()).agent?.paneId === fresh);
    expect((await chair()).seat?.adoptedPane).toBe(fresh);
    expect((await chair()).seat?.adoptedApproved).toBe(false);

    const cli = Bun.spawn(["python3", CLI, "adopt", "--project", h.dir, "--pane", fresh, "--session", "s-cli-wait"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", AGENTGLASS_SERVER: h.base, AGENTGLASS_TOKEN: MACHINE },
      stdout: "pipe", stderr: "pipe",
    });
    const card = await until(async () => (await requests()).find((c) => c.setting === "seat.adopt"));
    /* The command that exists to wait is still waiting: at HEAD it read the
       row naming its pane as approval and exited 1 before anybody clicked. */
    expect(cli.exitCode).toBeNull();

    expect((await decide(card.id, true)).status).toBe(200);
    const ended = await Promise.race([cli.exited, Bun.sleep(30_000).then(() => "timeout" as const)]);
    expect(ended).not.toBe("timeout");
    const said = await new Response(cli.stderr).text();
    const printed = await new Response(cli.stdout).text();
    expect(printed, said).not.toBe("");
    const out = JSON.parse(printed) as Record<string, any>;
    expect(out.ok).toBe(true);
    expect(String(out.token)).toMatch(/^st_/);
    expect((await chair()).seat?.adoptedPane).toBe(fresh);

    await h.asPerson("/seat/close", { root: h.dir });
    await h.closeTab(fresh);
  }, 60_000);

  test("a declined card ends the CLI at once instead of at the deadline, and it does not blame a card that is gone", async () => {
    await h.asPerson("/seat/close", { root: h.dir });
    const pane = await h.handTab(h.dir);
    const cli = Bun.spawn(["python3", CLI, "adopt", "--project", h.dir, "--pane", pane, "--session", "s-cli-declined"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", AGENTGLASS_SERVER: h.base, AGENTGLASS_TOKEN: MACHINE },
      stdout: "pipe", stderr: "pipe",
    });
    const card = await until(async () => (await requests()).find((c) => c.setting === "seat.adopt" && c.diff.join("\n").includes(pane)));
    /* Let the loop's own first read see the card, so its absence afterwards is
       the person's answer and not a card it never had. */
    await Bun.sleep(600);
    expect((await decide(card.id, false)).status).toBe(200);

    /* 25 s, not the loop's 180: a decline is an answer, and the command that
       used to sit out the whole deadline now returns with it. */
    const ended = await Promise.race([cli.exited, Bun.sleep(25_000).then(() => "timeout" as const)]);
    expect(ended).not.toBe("timeout");
    expect(ended).not.toBe(0);
    const said = await new Response(cli.stderr).text();
    const printed = await new Response(cli.stdout).text();
    expect(printed, said).not.toBe("");
    const out = JSON.parse(printed) as Record<string, any>;
    expect(out.ok).toBe(false);
    expect(out.declined).toBe(true);
    expect(out.waiting).toBe(false);
    expect(String(out.error)).toContain("declined");
    expect(String(out.error)).not.toContain("still waiting");
    expect((await chair()).seat?.adoptedApproved ?? false).toBe(false);
    await h.closeTab(pane);
  }, 60_000);
});
