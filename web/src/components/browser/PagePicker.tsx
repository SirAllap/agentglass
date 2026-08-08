// Point at something on the page.
//
// Two jobs behind one mechanism. In `pick` mode it is an inspector: hover an
// element, press C to put it on the clipboard or S to screenshot just that
// element. In `feedback` mode it is a handoff: click an element, say what
// should change, and an agent is started in a terminal with the page, the
// selector and the markup in front of it.
//
// The picking itself happens inside the page — see pagePickScript.ts for why it
// has to, and what it costs. This side installs it, polls for the answer, and
// does whatever the answer says.
import { useCallback, useEffect, useRef, useState } from "react";
import { installPick, readPick, removePick, hidePickChrome, showPickChrome } from "../../lib/pagePickScript.ts";
import { elementForClipboard, feedbackWindowName, pageFeedbackPrompt, parsePick, type Intent, type PickedElement } from "../../lib/pageRef.ts";
import { requestTermIssue } from "../../lib/termIssue.ts";
import { seedChat } from "../../lib/chatStore.ts";
import { api } from "../../lib/api.ts";
import type { GitRepoRef } from "../../../../shared/types.ts";
import { CheckoutPicker } from "../CheckoutPicker.tsx";

type Guest = {
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<{ toDataURL(): string }>;
} | null;

/** The desktop shell's clipboard bridge — a MAIN-process copy that works while
 *  the <webview> guest holds focus, which navigator.clipboard does not: the
 *  picker fires with focus in the guest, so a renderer write is denied for an
 *  unfocused document and fails silently (why "copied" used to copy nothing).
 *  Falls back to navigator.clipboard on a non-desktop build (a phone tab). */
type ClipBridge = { copyText?: (t: string) => Promise<boolean>; copyImage?: (d: string) => Promise<boolean> };
const clipBridge = (): ClipBridge | undefined => (window as unknown as { agentglass?: ClipBridge }).agentglass;

async function copyText(text: string): Promise<boolean> {
  const write = clipBridge()?.copyText;
  if (write) { try { return (await write(text)) !== false; } catch { return false; } }
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** A data URL onto the clipboard as a real image, so it can be pasted anywhere
 *  that takes one. Returns whether it actually landed. */
async function copyImageDataUrl(dataUrl: string): Promise<boolean> {
  const write = clipBridge()?.copyImage;
  if (write) { try { return (await write(dataUrl)) !== false; } catch { return false; } }
  try {
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
    return true;
  } catch { return false; }
}

export function PagePicker({ view, url, title, feedback, onNote, onDone }: {
  view: Guest;
  url: string;
  title: string;
  /** Clicking selects and opens the ask, instead of C/S doing something. */
  feedback: boolean;
  onNote: (msg: string) => void;
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [ask, setAsk] = useState("");
  const [intent, setIntent] = useState<Intent>("change");
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [repo, setRepo] = useState("");
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);

  /* Which checkout an agent should work in. The browser is not tied to one —
     you might be looking at the page a worktree serves, or at documentation —
     so it is asked rather than guessed, with the first as the default. */
  useEffect(() => {
    if (!feedback) return;
    api.gitRepos().then((r) => {
      setRepos(r.repos ?? []);
      setRepo((cur) => cur || r.repos?.[0]?.root || "");
    }).catch(() => {});
  }, [feedback]);

  /* Install, and take it away again — including when the mode is switched off
     from the toolbar, which is why the cleanup is not conditional. */
  useEffect(() => {
    if (!view) { onNote("There is no page to point at"); onDone(); return; }
    let dead = false;
    void view.executeJavaScript(installPick(feedback)).catch(() => {
      if (!dead) { onNote("This page will not allow the picker — some sites block injected script"); onDone(); }
    });
    return () => {
      dead = true;
      void view.executeJavaScript(removePick).catch(() => {});
    };
  }, [view, feedback, onNote, onDone]);

  const shoot = useCallback(async (p: PickedElement) => {
    if (!view) return;
    if (p.rect.width < 1 || p.rect.height < 1) { onNote("That element has no size to capture"); return; }
    try {
      // The outline is not part of the thing it is outlining.
      await view.executeJavaScript(hidePickChrome).catch(() => {});
      // A frame, so the hide has actually painted before the capture.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const img = await view.capturePage(p.rect);
      await view.executeJavaScript(showPickChrome).catch(() => {});
      const ok = await copyImageDataUrl(img.toDataURL());
      onNote(ok
        ? `Screenshot of that ${p.tag} copied — ${p.rect.width}×${p.rect.height}`
        : "Captured it, but the clipboard refused the image");
    } catch {
      await view.executeJavaScript(showPickChrome).catch(() => {});
      onNote("That element could not be captured");
    }
  }, [view, onNote]);

  /* Poll for a decision. The guest has no way to push one — no preload, no
     IPC — so this is the only shape available. Every 140ms: fast enough that a
     keystroke feels immediate, slow enough to be free. */
  useEffect(() => {
    if (!view || picked) return;
    let live = true;
    const tick = async () => {
      if (!live) return;
      let raw: unknown;
      try { raw = await view.executeJavaScript(readPick); } catch { return; }
      const p = parsePick(raw);
      if (!p || !live) return;
      if (p.action === "cancel") { onDone(); return; }
      if (p.action === "copy") {
        const ok = await copyText(elementForClipboard(p, url));
        onNote(ok ? `That ${p.tag} copied — selector and markup` : "Couldn't reach the clipboard");
        return;
      }
      if (p.action === "shoot") { await shoot(p); return; }
      if (p.action === "select") {
        if (!feedback) { const ok = await copyText(elementForClipboard(p, url)); onNote(ok ? `That ${p.tag} copied` : "Couldn't reach the clipboard"); return; }
        setPicked(p);
        setTimeout(() => box.current?.focus(), 0);
      }
    };
    const timer = setInterval(() => { void tick(); }, 140);
    return () => { live = false; clearInterval(timer); };
  }, [view, picked, feedback, url, onNote, onDone, shoot]);

  const hand = async (where: "terminal" | "chat") => {
    if (!picked) return;
    const cwd = repo || repos[0]?.root;
    if (!cwd) { onNote("No repository is open for an agent to work in"); return; }
    setSending(true);
    try {
      const prompt = pageFeedbackPrompt({ url, title, intent, ask, element: picked });
      if (where === "terminal") {
        requestTermIssue(cwd, feedbackWindowName(url), prompt, true);
        onNote(`Handed to Claude in a tmux window — "${feedbackWindowName(url)}", in ${cwd.split("/").pop()}`);
      } else {
        seedChat(cwd, prompt, intent === "change" ? "Change something on a page" : "A question about a page");
        onNote("Waiting for you in the chat");
      }
      onDone();
    } finally { setSending(false); }
  };

  if (!picked) return null;

  /* The ask, over the page, anchored near what was picked — a dialog in the
     middle of the screen makes you look away from the thing you are talking
     about. Clamped so it is never off the edge. */
  const left = Math.min(Math.max(8, picked.rect.x), Math.max(8, window.innerWidth - 380));
  const below = picked.rect.y + picked.rect.height + 8;
  const top = below + 260 > window.innerHeight ? Math.max(8, picked.rect.y - 250) : below;

  return (
    <div className="absolute inset-0" style={{ zIndex: 30 }} onClick={onDone}>
      <div onClick={(e) => e.stopPropagation()}
        className="absolute rounded-xl shadow-2xl flex flex-col gap-2 p-3"
        style={{
          left, top, width: 360,
          background: "var(--bg2)",
          border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
        }}>
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[11px] font-semibold" style={{ color: "var(--text)" }}>
            {picked.tag}{picked.id ? `#${picked.id}` : ""}
          </span>
          <span className="text-[9.5px] tabular-nums" style={{ color: "var(--text3)" }}>
            {picked.rect.width}×{picked.rect.height}
          </span>
          <span className="ml-auto text-[10px] font-mono truncate min-w-0" style={{ color: "var(--text3)" }}
            title={picked.selector}>{picked.selector}</span>
        </div>

        <textarea ref={box} value={ask} onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onDone(); }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void hand("terminal"); }
          }}
          rows={3} spellCheck={false}
          placeholder="What should the agent change here?"
          className="w-full rounded-lg px-2 py-1.5 text-[11.5px] outline-none resize-none"
          style={{ background: "var(--bg)", border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)" }} />

        <div className="flex items-center gap-1">
          {(["change", "question"] as Intent[]).map((k) => (
            <button key={k} onClick={() => setIntent(k)}
              className="text-[10.5px] px-2 py-1 rounded-lg flex-1"
              style={{
                color: intent === k ? "var(--text)" : "var(--text3)",
                background: intent === k ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
                border: `1px solid color-mix(in srgb, var(--border) ${intent === k ? 55 : 30}%, transparent)`,
              }}>{k === "change" ? "✎ Change it" : "? Just asking"}</button>
          ))}
        </div>

        {repos.length > 1 && (
          <CheckoutPicker repos={repos} value={repo} onPick={setRepo}
            title="Which checkout the agent works in" triggerMaxWidth={200} />
        )}

        {/* Terminal first, chat as the lesser option — the same order and the
            same reason as the conflict handoff. */}
        <div className="flex items-center gap-2">
          <button onClick={() => void hand("terminal")} disabled={sending}
            className="agx-btn text-[11px] px-2.5 py-1 rounded-lg flex-1"
            style={{ color: "var(--primary-hover)", border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", opacity: sending ? 0.5 : 1 }}>
            ▸_ Hand it to Claude
          </button>
          <button onClick={() => void hand("chat")} disabled={sending}
            className="text-[10px] px-1 shrink-0"
            style={{ color: "var(--text3)", textDecoration: "underline", textUnderlineOffset: 3 }}>in the chat</button>
          <button onClick={onDone} className="text-[10px] px-1 shrink-0" style={{ color: "var(--text3)" }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
