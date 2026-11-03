/*
 * The console bar under the Docker view. Mounted once by the frame, not by a
 * section: switching sections must not take the shell, its history or its
 * running job down with the list above it.
 */
import { ConsoleStrip, consoleRoot } from "../TerminalPanel.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { TerminalIcon } from "../../lib/glyphIcons.tsx";

export function ConsoleDock({ show, open, height, onHeight, onClose, onToggle }: {
  /** No daemon answer yet: the strip stays (a shell already open is still
   *  running), the bar does not promise a stream that is not there. */
  show: boolean;
  open: boolean;
  height: number;
  onHeight: (h: number) => void;
  onClose: () => void;
  onToggle: () => void;
}) {
  return (
    <>
      <ConsoleStrip root={consoleRoot()} open={open} height={height} onHeight={onHeight} onClose={onClose} />
      {show && (
        <div className="dk-dock">
          <button type="button" className="dk-chip sm" onClick={onToggle}
            title="A shell in this project, docked under the view. It keeps running while you look around.">
            <TerminalIcon size={ICON.xs} />Console
          </button>
          <span className="mut">A shell in this project, docked under the view. It keeps running while you look around.</span>
          <span className="cr"><i className="dk-live" />Live: changes arrive from Docker's event stream</span>
        </div>
      )}
    </>
  );
}
