/*
 * The browser, in the bench.
 *
 * It is THE browser, not a copy: the workspace mounts one BrowserView and
 * lib/browserHost.ts lays its box over this slot while the bench holds it. Same
 * tabs, same page, same history, same sidebar — what you do here shows in the
 * Browser view and the other way round. Like the boards, it is shown in one
 * place at a time; the other place says where it is and offers to bring it.
 *
 * Outside the desktop shell there is no `<webview>` at all — a plain browser tab
 * cannot embed another site, and an iframe would be refused by every host worth
 * opening. It says so rather than showing an empty rectangle.
 */
import { useId, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { HAS_BROWSER, IS_DESKTOP } from "../../lib/desktop.ts";
import {
  browserHolder, browserPlace, claimBrowserSlot, registerBrowserSlot, setBrowserSlotVisible, subscribeBrowser,
} from "../../lib/browserHost.ts";
import { Chip } from "../workspace/Chrome.tsx";

export function BenchWeb({ active }: {
  /** Is this the tab on screen? The browser does real work per frame — guests,
   *  devtools rectangles, favicons — and does none of it while this is false. */
  active: boolean;
}) {
  if (!IS_DESKTOP || !HAS_BROWSER) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center text-[12px]" style={{ color: "var(--text3)" }}>
        <p>A page needs the desktop app.</p>
        <p className="text-[11px]" style={{ color: "var(--text4)" }}>
          In a browser tab this would be an iframe, and the sites worth opening here refuse to be framed.
        </p>
      </div>
    );
  }
  return <BenchBrowserSlot active={active} />;
}

function BenchBrowserSlot({ active }: { active: boolean }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const seen = useRef(active);
  seen.current = active;
  useLayoutEffect(() => {
    if (!box.current) return;
    return registerBrowserSlot(id, "bench", box.current, seen.current);
  }, [id]);
  useLayoutEffect(() => { setBrowserSlotVisible(id, active); }, [id, active]);
  const holds = useSyncExternalStore(subscribeBrowser, () => browserHolder() === id, () => false);
  const where = useSyncExternalStore(subscribeBrowser, browserPlace, () => null);
  return (
    <div ref={box} className="relative w-full h-full" style={{ background: "var(--bg)" }}>
      {!holds && where && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-[12px]" style={{ color: "var(--text2)" }}>The browser is open in its view, behind this window.</div>
          <div className="text-[10.5px] max-w-[360px]" style={{ color: "var(--text4)" }}>
            One browser, shown in one place at a time, so both places always agree.
          </div>
          <Chip primary onClick={() => claimBrowserSlot(id)}>Show it here</Chip>
        </div>
      )}
    </div>
  );
}
