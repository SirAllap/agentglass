/*
 * `upload` could not address an input it had just found.
 *
 * A file input cannot be filled from script — the value is read-only by design
 * — so the verb hands Chromium the paths through the debugger:
 *
 *     Runtime.evaluate     -> a remote object for the input
 *     DOM.requestNode      -> that object as a nodeId
 *     DOM.setFileInputFiles-> the paths, against that nodeId
 *
 * The middle step answered with no nodeId, so the verb returned "could not
 * address that input" about an element the step above had returned. Measured
 * against the real app on a page whose `<input id="f" type="file">` existed and
 * whose `querySelector` returned it.
 *
 * The cause is a rule of the protocol rather than anything about the page:
 * `DOM.requestNode` translates a Runtime object by looking it up in the DOM
 * agent's node map, and that map is EMPTY until the document has been pulled
 * once. `DOM.enable` does not pull it. `DOM.getDocument` does.
 *
 * After the fix, verified from outside the path that produced it — not by
 * trusting what the verb said, and not by trusting what the page said it got,
 * but by comparing what arrived against the file that was sent:
 *
 *     sent      296 bytes, first line AGX_UPLOAD_MARKER_88213
 *     arrived   {"name":"subir.txt","size":296,"sha_head":"AGX_UPLOAD_MARKER_88213..."}
 *
 * This test asserts the ORDER of the protocol calls, because that is the whole
 * bug and it is the one thing a stand-in protocol can see. A real one needs
 * Electron, a guest process, and the single debugger seat a page has.
 */
import { describe, expect, test } from "bun:test";
import { runBrowserAsk } from "../src/lib/browserDrive.ts";

type Sent = Array<{ method: string; params?: unknown }>;

function fakeCdp(answers: Record<string, unknown> = {}) {
  const sent: Sent = [];
  const cdp = async (method: string, params?: unknown) => {
    sent.push({ method, params });
    return method in answers ? { ok: true, result: answers[method] } : { ok: true, result: {} };
  };
  return { cdp, sent };
}

function fakeGuest() {
  return {
    executeJavaScript: async () => undefined,
    getURL: () => "http://example.invalid/",
    getTitle: () => "",
  } as never;
}

const ask = (op: string, args: Record<string, unknown>) => ({ op, args }) as never;

describe("upload, and the node map it depends on", () => {
  test("pulls the document before asking for a nodeId", async () => {
    const f = fakeCdp({
      "Runtime.evaluate": { result: { objectId: "obj-1" } },
      "DOM.requestNode": { nodeId: 42 },
      "DOM.setFileInputFiles": {},
    });
    const r = await runBrowserAsk(
      fakeGuest(), ask("upload", { selector: "#f", paths: ["/tmp/a.txt"] }),
      undefined, undefined, undefined, f.cdp,
    );
    expect(r.ok).toBe(true);

    const order = f.sent.map((s) => s.method);
    const doc = order.indexOf("DOM.getDocument");
    const req = order.indexOf("DOM.requestNode");
    expect(doc, "DOM.getDocument is called at all").toBeGreaterThan(-1);
    // The assertion that is the bug: the map has to exist before it is read.
    expect(doc, "the document is pulled BEFORE requestNode").toBeLessThan(req);
  });

  test("the paths reach setFileInputFiles against the resolved node", async () => {
    const f = fakeCdp({
      "Runtime.evaluate": { result: { objectId: "obj-1" } },
      "DOM.requestNode": { nodeId: 42 },
      "DOM.setFileInputFiles": {},
    });
    await runBrowserAsk(
      fakeGuest(), ask("upload", { selector: "#f", paths: ["/tmp/a.txt", "/tmp/b.txt"] }),
      undefined, undefined, undefined, f.cdp,
    );
    const call = f.sent.find((s) => s.method === "DOM.setFileInputFiles");
    // A verb that declares its arguments and sends none of them is the shape
    // this family of bugs keeps taking, so the paths are asserted where they
    // land rather than where they were declared.
    expect(call?.params).toEqual({ files: ["/tmp/a.txt", "/tmp/b.txt"], nodeId: 42 });
  });

  test("a node that cannot be addressed is still reported, not swallowed", async () => {
    const f = fakeCdp({ "Runtime.evaluate": { result: { objectId: "obj-1" } } }); // requestNode answers {}
    const r = await runBrowserAsk(
      fakeGuest(), ask("upload", { selector: "#f", paths: ["/tmp/a.txt"] }),
      undefined, undefined, undefined, f.cdp,
    );
    expect(r.ok).toBe(false);
    expect(String((r as { error?: string }).error)).toContain("could not address");
  });
});
