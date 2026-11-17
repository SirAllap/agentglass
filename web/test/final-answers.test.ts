// `GET /clickup/list?id=ORBIT` answered 400 and was asked again every few
// seconds while a pull request's sidebar was open: a Jira card's project key
// in the field a ClickUp control reads as its list, asked on every mount.
import { expect, test } from "bun:test";
import { REFUSED_MS, finalAnswers, isFinalRefusal, refusalStatus } from "../src/lib/finalAnswers.ts";
import { clickupListIdShape } from "../../shared/cardRef.ts";

const httpError = (status: number) => new Error(`/clickup/list?id=ORBIT → ${status}`);

test("a ClickUp list id is digits; another tracker's project key is not one", () => {
  expect(clickupListIdShape("901234567")).toBe(true);
  for (const no of ["ORBIT", "ORBIT-1042", "", "90 1", "901a", undefined, null, 901]) expect(clickupListIdShape(no)).toBe(false);
});

test("which failures are an answer", () => {
  expect(refusalStatus(httpError(400))).toBe(400);
  expect(refusalStatus(new TypeError("fetch failed"))).toBe(0);
  for (const s of [400, 401, 403, 404, 422]) expect(isFinalRefusal(httpError(s))).toBe(true);
  // Asked again: the network, the server's own trouble, "slow down" and "too slow".
  for (const s of [500, 502, 503, 408, 429]) expect(isFinalRefusal(httpError(s))).toBe(false);
  expect(isFinalRefusal(new TypeError("fetch failed"))).toBe(false);
});

test("a 4xx is asked once for the same key, and again only when it has aged out", async () => {
  let clock = 1_000_000;
  const asked: string[] = [];
  const ask = finalAnswers(async (key: string) => { asked.push(key); throw httpError(400); }, () => clock);
  for (let i = 0; i < 5; i++) await expect(ask("ORBIT")).rejects.toThrow("→ 400");
  expect(asked).toEqual(["ORBIT"]);
  // Another input is another question.
  await expect(ask("ACME")).rejects.toThrow("→ 400");
  expect(asked).toEqual(["ORBIT", "ACME"]);
  clock += REFUSED_MS + 1;
  await expect(ask("ORBIT")).rejects.toThrow("→ 400");
  expect(asked).toEqual(["ORBIT", "ACME", "ORBIT"]);
});

test("a network failure or a 5xx is not remembered, and an answer is not kept", async () => {
  const asked: string[] = [];
  let next: () => Promise<string> = async () => { throw new TypeError("fetch failed"); };
  const ask = finalAnswers((key: string) => { asked.push(key); return next(); });
  await expect(ask("901")).rejects.toThrow("fetch failed");
  next = async () => { throw httpError(503); };
  await expect(ask("901")).rejects.toThrow("→ 503");
  next = async () => "statuses";
  expect(await ask("901")).toBe("statuses");
  expect(await ask("901")).toBe("statuses");
  expect(asked.length).toBe(4);
});

test("the same key in flight is one request", async () => {
  let n = 0;
  let open!: (v: string) => void;
  const ask = finalAnswers(() => { n++; return new Promise<string>((r) => { open = r; }); });
  const a = ask("901"), b = ask("901");
  open("statuses");
  expect(await Promise.all([a, b])).toEqual(["statuses", "statuses"]);
  expect(n).toBe(1);
});

const apiSource = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();
const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

test("the list read checks the shape first and goes through the memory", () => {
  const at = apiSource.indexOf("  clickupList: (id: string, repo?: string)");
  expect(at).toBeGreaterThan(-1);
  const body = apiSource.slice(at, apiSource.indexOf("\n  /**", at));
  expect(body).toContain("clickupListIdShape(id) ? clickupListAsk(repo ? `${repo}\\n${id}` : id) :");
  expect(body).not.toContain("get<");
  expect(apiSource).toContain("const clickupListAsk = finalAnswers(");
});

test("a card Jira answered for is drawn by the Jira section, not handed to the ClickUp controls", () => {
  expect(panel).toContain('if (ref.tracker === "jira" || hit?.by === "jira") return <JiraCardFacts');
});
