// The Live panel when a headless worker is selected.
//
// A headless turn fires no hooks: its steps go to `worker-runs/<name>/out` and
// its tab is the reader that draws them (server/agents/opencodeview.py), so the
// event feed has nothing to scope by session. `/agents/named/read` answers with
// that tab's lines, which is the same view `agentglass-agent read <name>` gives.
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { usePoll } from "../lib/usePoll.ts";
import { Panel } from "./Panel.tsx";

const READ_POLL_MS = 2_000;
const READ_LINES = 300;

export function WorkerLive({ name }: { name: string }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const load = () => {
    void api.agentRead(name, READ_LINES).then((r) => {
      if (r.ok && r.result) { setText(r.result.text); setErr(""); }
      else setErr(r.error ?? "its window could not be read");
    }).catch(() => setErr("its window could not be read"));
  };
  // The first read is immediate: a poll's first beat would leave the panel
  // blank for two seconds on a row somebody just pressed.
  useEffect(() => { setText(""); setErr(""); load(); }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  usePoll(true, load, READ_POLL_MS);

  // The reader's own header is not a step: a turn that has printed nothing yet
  // still gets the one sentence, and the panel says there is nothing to see.
  const steps = text.split("\n").filter((l) => l.trim() && !l.startsWith("headless opencode worker ·"));

  return (
    <Panel eyebrow={`Live · ${name}`} title={`Live steps — ${name}`}>
      <div className="h-full min-h-0 flex flex-col" data-worker={name}>
        <div className="flex-1 min-h-0 overflow-auto">
          {err
            ? <div className="t-dim2 text-center py-8">{err}</div>
            : steps.length
              ? <pre className="m-0 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap break-words">{steps.join("\n")}</pre>
              : <div className="t-dim2 text-center py-8">No steps yet from {name}</div>}
        </div>
      </div>
    </Panel>
  );
}
