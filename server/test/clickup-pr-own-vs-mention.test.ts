/*
 * A stacked pull request names the card under it, so the text search for that
 * card returns both pull requests and the newer one led both cards' chips.
 * `prLinkKind` is the decision that tells a pull request CUT FOR a card from
 * one that only NAMES it; these are the shapes it has to get right.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prLinkKind } from "../src/clickup.ts";

const A = { cardId: "ORBIT-2001" };
const B = { cardId: "ORBIT-2002" };
// Two stacked pull requests: the second says it depends on the first.
const base = { headRefName: "ORBIT-2001-add-thing", title: "Add the thing", body: "Adds the thing." };
const top = {
  headRefName: "ORBIT-2002-use-thing", title: "Use the thing",
  body: "Depends on #101 (ORBIT-2001 add the thing), stacked on it.",
};

describe("prLinkKind", () => {
  it("is own for the card the branch was cut for, mention for the card it sits on", () => {
    expect(prLinkKind(A, base)).toBe("own");
    expect(prLinkKind(B, top)).toBe("own");
    expect(prLinkKind(A, top)).toBe("mention");
  });

  it("is a mention both ways round when each body names the other", () => {
    const first = { ...base, body: "Followed by #102 (ORBIT-2002)." };
    expect(prLinkKind(B, first)).toBe("mention");
    expect(prLinkKind(A, first)).toBe("own");
    expect(prLinkKind(B, top)).toBe("own");
    expect(prLinkKind(A, top)).toBe("mention");
  });

  it("is null when the text does not carry the card, or only a longer id", () => {
    expect(prLinkKind({ cardId: "ORBIT-200" }, base)).toBeNull();
    expect(prLinkKind({ cardId: "ORBIT-20010" }, base)).toBeNull();
    expect(prLinkKind(B, base)).toBeNull();
  });

  it("one pull request that names three cards is own for one and a mention for the others", () => {
    const pr = { headRefName: "ORBIT-2002-x", title: "x", body: "Touches ORBIT-2001, ORBIT-2003 and ORBIT-2004 too." };
    expect(prLinkKind(B, pr)).toBe("own");
    for (const id of ["ORBIT-2001", "ORBIT-2003", "ORBIT-2004"]) expect(prLinkKind({ cardId: id }, pr)).toBe("mention");
  });

  it("reads the id from the title when the branch carries none, in any common spelling", () => {
    for (const title of ["ORBIT-2002: use the thing", "[ORBIT-2002] use the thing", "fix(ORBIT-2002): use the thing", "Use the thing (ORBIT-2002)"]) {
      const pr = { headRefName: "fix/use-thing", title, body: "On top of ORBIT-2001." };
      expect(prLinkKind(B, pr)).toBe("own");
      expect(prLinkKind(A, pr)).toBe("mention");
    }
  });

  it("branch separators and case do not change who owns it", () => {
    for (const head of ["fix/ORBIT-2002-use-thing", "user/ada/ORBIT-2002-use-thing", "feature/ORBIT-2002/use-thing", "ORBIT-2002"]) {
      const pr = { headRefName: head, title: "Use the thing", body: "Needs ORBIT-2001." };
      expect(prLinkKind(B, pr)).toBe("own");
      expect(prLinkKind(A, pr)).toBe("mention");
    }
    // A lower-case branch is not read as an id by the reader, so the card
    // still finds its own pull request through the branch text.
    const lower = { headRefName: "orbit-2002-use-thing", title: "Use the thing", body: "Needs ORBIT-2001." };
    expect(prLinkKind(B, lower)).toBe("own");
    expect(prLinkKind(A, lower)).toBe("mention");
  });

  it("an id that appears only in prose, with no other id next to it, is still the card's", () => {
    const pr = { headRefName: "fix/thing", title: "Fix the thing", body: "Part of ORBIT-2002." };
    expect(prLinkKind(B, pr)).toBe("own");
  });

  it("an id in prose beside another item's is a mention", () => {
    const pr = { headRefName: "fix/thing", title: "Fix the thing", body: "Follows ORBIT-2001, closes ORBIT-2002." };
    expect(prLinkKind(A, pr)).toBe("mention");
    expect(prLinkKind(B, pr)).toBe("mention");
  });

  it("the default id works the same way", () => {
    const pr = { headRefName: "CU-86abc123_retry", title: "Retry", body: "On top of ORBIT-2001." };
    expect(prLinkKind({ cardId: "", taskId: "86abc123" }, pr)).toBe("own");
    expect(prLinkKind({ ...A, taskId: "86def456" }, pr)).toBe("mention");
    // Ceiling: asked without the task's own id, a native branch cannot be told
    // from this card's, so the card keeps it.
    expect(prLinkKind(A, pr)).toBe("own");
  });
});

const dir = mkdtempSync(join(tmpdir(), "agx-own-mention-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const row = (number: number, o: { headRefName: string; title: string; body: string }) =>
  ({ number, state: "OPEN", url: `https://github.com/acme/orbit/pull/${number}`, author: { login: "ada" }, ...o });
writeFileSync(join(dir, "rows.json"), JSON.stringify([row(101, base), row(102, top)]));
const stub = join(dir, "gh");
writeFileSync(stub, `#!/bin/sh
echo "$@" >> "$AGX_STUB_CALLS"
case "$1" in
  api) echo ada ;;
  pr) cat "$AGX_STUB_ROWS" ;;
esac
`);
chmodSync(stub, 0o755);

async function ask(card: string) {
  const calls = join(dir, `calls-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(calls, "");
  const script = `import { cardPullRequests } from ${JSON.stringify(new URL("../src/clickup.ts", import.meta.url).pathname)};
    console.log(JSON.stringify(await cardPullRequests(${JSON.stringify(card)}, undefined, ${JSON.stringify(dir)}, "")));`;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: {
      PATH: `${dir}:${process.env.PATH}`, HOME: dir, NODE_ENV: "test", XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: dir, AGENTGLASS_DB: join(dir, "t.db"), AGX_STUB_CALLS: calls, AGX_STUB_ROWS: join(dir, "rows.json"),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const lines = readFileSync(calls, "utf8").split("\n").filter(Boolean);
  return { got: JSON.parse(out.trim().split("\n").pop()!), search: lines.filter((l) => l.startsWith("pr list")) };
}

describe("clickup/prs says which pull request is whose", () => {
  it("answers each card's search with the link kind, in the one search it already made", async () => {
    const a = await ask("ORBIT-2001");
    const b = await ask("ORBIT-2002");
    expect(a.search).toHaveLength(1);
    expect(b.search).toHaveLength(1);
    const brief = (r: { got: { prs: { number: number; link: string; belongsTo?: string }[] } }) =>
      r.got.prs.map((p) => [p.number, p.link, p.belongsTo ?? null]);
    expect(brief(a)).toEqual([[102, "mention", "ORBIT-2002"], [101, "own", null]]);
    expect(brief(b)).toEqual([[102, "own", null]]);
  });
});
