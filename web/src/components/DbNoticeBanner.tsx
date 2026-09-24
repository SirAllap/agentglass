// Says out loud when there is a second agentglass.db the server is not using.
//
// A database file in the directory the server started from no longer wins
// over the data dir (see defaultDbPath in server/src/db.ts). When the data dir
// was empty that file was copied there and this says so once; when both
// exist, the other file's history is not what is on screen, and a line on the
// server's stderr is not where anybody looks. Both paths are shown in full so
// the person can go and look, and the move is spelled out because getting it
// backwards replaces the history that is in use.
//
// Asked once: the server decides this at startup and never changes its mind.
// Closing it lasts until the page is reloaded.
import { useEffect, useState } from "react";
import { api, IS_DEMO } from "../lib/api.ts";
import { CloseButton } from "./CloseButton.tsx";
import type { DbNotice } from "../../../shared/types.ts";

export default function DbNoticeBanner() {
  const [notice, setNotice] = useState<DbNotice | null>(null);

  useEffect(() => {
    if (IS_DEMO) return;
    let live = true;
    api.dbNotice().then((n) => { if (live) setNotice(n); }).catch(() => { /* origin gate, offline — ServerBanner owns that story */ });
    return () => { live = false; };
  }, []);

  if (!notice) return null;
  return <DbNoticeView notice={notice} onClose={() => setNotice(null)} />;
}

export function DbNoticeView({ notice, onClose }: { notice: DbNotice; onClose: () => void }) {
  const { stray, db } = notice;
  return (
    <div
      role="alert"
      className="shrink-0 px-4 py-2 text-[11px] flex items-start gap-2 border-b"
      style={{
        background: "color-mix(in srgb, var(--warning) 12%, transparent)",
        borderColor: "color-mix(in srgb, var(--warning) 30%, transparent)",
        color: "var(--text)",
      }}
    >
      {/* The text wraps on its own so the ✕ stays top-right rather than
          dropping to a line of its own under two long paths. */}
      <div className="flex-1 min-w-0 flex items-center gap-x-2 gap-y-1 flex-wrap break-words">
      {notice.kind === "copied" ? (
        <>
          <span className="font-semibold" style={{ color: "var(--warning)" }}>history copied</span>
          <span>
            <code>{stray}</code> was copied to <code>{db}</code>, which is the database from now on. The original is
            untouched and no longer used; delete it once you have checked the history here.
          </span>
        </>
      ) : (
        <>
          <span className="font-semibold" style={{ color: "var(--warning)" }}>second database not in use</span>
          <span>
            This history is <code>{db}</code>. The one at <code>{stray}</code>, in the folder the server started from, is
            not shown.
          </span>
          <span style={{ color: "var(--text3)" }}>
            To use that one instead, stop agentglass and run <code>{notice.switchCommand}</code> — that replaces the
            current history. To keep this one, delete or move the other file.
          </span>
        </>
      )}
      </div>
      <CloseButton onClick={onClose} title="Hide until the page is reloaded" className="shrink-0" />
    </div>
  );
}
