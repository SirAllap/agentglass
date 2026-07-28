/*
 * The phone had no live connection at all.
 *
 * `grep -rn WebSocket web/src/mobile/` returned nothing, and the reason was
 * written down in MobileApp: a socket reconnecting behind a dark screen is a
 * worse deal than a few small requests. The battery half of that is right. The
 * conclusion gave up the product's premise — a server with no channel to a
 * device cannot tell it anything — so a gate arrived up to four seconds late,
 * an action taken here took up to a minute to reach the desk, and "what is that
 * agent doing right now" had no answer, which is why the home screen animated
 * fourteen bars off a tool COUNT and put them where telemetry goes.
 *
 * These are mostly rules over the tree rather than assertions about today's
 * call sites. Wiring one screen to the socket is worth little if the next one
 * is written the old way, and a decorative gauge is the kind of thing that
 * grows back.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionChanged, subscribeSessionChanged } from "../src/lib/sessionBus.ts";

const SRC = join(import.meta.dir, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

/**
 * Source with its comments removed.
 *
 * The rule below is about what the code does, not about what the comments say —
 * and the first thing it caught was the comment recording the formula it was
 * written to ban. That comment earns its place: it is why the rule exists.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("the session bus", () => {
  test("delivers the id to every subscriber", () => {
    const seen: string[] = [];
    const offA = subscribeSessionChanged((id) => seen.push("a:" + id));
    const offB = subscribeSessionChanged((id) => seen.push("b:" + id));
    sessionChanged("s1");
    expect(seen).toEqual(["a:s1", "b:s1"]);
    offA(); offB();
  });

  test("unsubscribing stops delivery", () => {
    const seen: string[] = [];
    const off = subscribeSessionChanged((id) => seen.push(id));
    sessionChanged("s1");
    off();
    sessionChanged("s2");
    expect(seen).toEqual(["s1"]);
  });

  test("one bad listener does not stop the rest", () => {
    // A screen that throws while re-rendering must not silently stop every
    // other screen from ever hearing about a change again.
    const seen: string[] = [];
    const offBad = subscribeSessionChanged(() => { throw new Error("boom"); });
    const offGood = subscribeSessionChanged((id) => seen.push(id));
    expect(() => sessionChanged("s1")).not.toThrow();
    expect(seen).toEqual(["s1"]);
    offBad(); offGood();
  });
});

describe("the phone is on the socket", () => {
  const app = read("mobile/MobileApp.tsx");

  test("MobileApp subscribes, and without the cockpit's event buffer", () => {
    // The second argument is what makes this affordable on a phone: the same
    // subscription, minus the two-thousand-row buffer that exists for an event
    // stream the companion does not draw.
    expect(app).toContain("useLive(false, false)");
    expect(app).toContain("openTools");
  });

  test("it listens to the git and session buses rather than polling for them", () => {
    expect(app).toContain("subscribeGitChanged");
    expect(app).toContain("subscribeSessionChanged");
  });

  test("useLive announces session frames instead of dropping them", () => {
    const live = read("lib/useLive.ts");
    expect(live).toContain("sessionChanged(frame.data.session_id)");
    // The old comment claimed session frames were ignored on purpose. If that
    // line comes back the wiring above has been undone.
    expect(live).not.toContain('"session" frames are ignored');
  });
});

describe("the polls are a backstop, not the delivery mechanism", () => {
  const app = read("mobile/MobileApp.tsx");
  const ms = (name: string) => {
    const m = new RegExp(`const ${name} = ([0-9_]+);`).exec(app);
    if (!m) throw new Error(`${name} not found`);
    return Number(m[1].replace(/_/g, ""));
  };

  test("the gate poll is no longer a four-second heartbeat", () => {
    // It was 4s because it was the only way a held gate could ever arrive.
    // The socket carries that now, so this is what covers a dropped connection.
    expect(ms("GATE_MS")).toBeGreaterThanOrEqual(15_000);
  });

  test("the working tree is not re-read every thirty seconds", () => {
    expect(ms("TREE_MS")).toBeGreaterThanOrEqual(60_000);
  });
});

describe("nothing on the phone draws telemetry it does not have", () => {
  test("no gauge is driven by a tool count", () => {
    // `1 + ((s.tool_count % 5) * 0.35)` fed fourteen animated bars that sat
    // where live activity belongs. A count is not a rate, and an app with no
    // connection had nothing to animate from — so the rule is that a tool
    // count may not drive a duration, an animation or a size.
    const offenders: string[] = [];
    for (const file of walk(join(SRC, "mobile"))) {
      if (/tool_count\s*%/.test(code(readFileSync(file, "utf8")))) offenders.push(file.replace(SRC, ""));
    }
    expect(offenders, "a tool count is being turned into an animation rate").toEqual([]);
  });

  test("the open-call strip comes from the server's list", () => {
    const now = code(read("mobile/MobileNow.tsx"));
    expect(now).toContain("LiveCall");
    // The bars are gone, and so is the CSS that animated them.
    expect(now).not.toContain("mb-vitals");
    expect(now).not.toContain("@keyframes mb-vit");
  });

  test("the connection indicator reports the connection", () => {
    const app = read("mobile/MobileApp.tsx");
    // It used to say "Live" when one four-second poll had come back, on an app
    // with no live connection. Three states now, because "the socket is gone
    // but the server still answers" is neither of the other two.
    expect(app).toContain("LinkState");
    expect(app).toContain('conn === "open"');
    expect(app).toContain("Catching up");
  });
});

describe("one failed request at boot no longer disables the app", () => {
  const app = read("mobile/MobileApp.tsx");

  test("the repository list retries", () => {
    // Every poll except gates is gated on `repos.length`, and this was a single
    // fetch on mount with an empty catch — so one failure at boot left the
    // tree, pull requests and docker permanently empty with no refresh control
    // anywhere on the phone to recover with.
    expect(app).toContain("loadRepos");
    const retry = app.slice(app.indexOf("if (repos.length) return;"));
    expect(retry.slice(0, 200)).toContain("setTimeout(loadRepos");
  });

  test("the gated poll effect is still gated, so the retry is what unblocks it", () => {
    expect(app).toContain("if (!repos.length) return;");
  });
});
