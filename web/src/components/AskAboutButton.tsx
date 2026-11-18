/*
 * The "Ask about this" button: the same label, icon and place (right end of a panel's header) on every panel that has
 * one. It opens a NEW agent terminal tab seeded with what the panel shows (lib/askAbout.ts builds the seed from the
 * panel's own data). Nothing runs until the person types.
 */
import { useState } from "react";
import { askAbout } from "../lib/askAbout.ts";
import type { AskSeed } from "../lib/askSeed.ts";
import { sentNote } from "../lib/sendToTerminal.ts";
import { tipAttr } from "../lib/tip.ts";
import { ICON } from "../lib/iconSize.ts";
import { SparkleIcon } from "../lib/glyphIcons.tsx";
import { Button } from "./workspace/Chrome.tsx";

export function AskAboutButton({ cwd, seed, what, onSaid, disabled }: {
  /** The folder the new tab opens in; resolved at click time when it is not known yet. */
  cwd: string | (() => Promise<string>);
  /** Built at click time from the panel's data: nothing is read until the person asks. */
  seed: () => AskSeed;
  /** What the note names: "#482", "ORBIT-1042", "The disk report". */
  what: string;
  onSaid?: (ok: boolean, text: string) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const dir = typeof cwd === "string" ? cwd : await cwd();
      if (!dir) { onSaid?.(false, "Not started: no project folder is known"); return; }
      const n = sentNote(await askAbout(dir, seed()), what);
      onSaid?.(n.ok, n.text);
    } catch (e) { onSaid?.(false, `Not started: ${String(e)}`); }
    finally { setBusy(false); }
  };
  return (
    <Button size="hit" className="shrink-0" data-ask-about disabled={disabled || busy} onClick={() => void go()}
      data-tip={tipAttr({ name: "Ask about this", text: "Open a new terminal tab that already has what is on this panel. Nothing runs until you type." })}>
      <SparkleIcon size={ICON.sm} />Ask about this
    </Button>
  );
}
