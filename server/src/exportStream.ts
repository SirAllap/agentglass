// Streamed bodies for GET /export. The output is byte for byte what the old
// in-memory build produced (JSON.stringify(rows, null, 2) and lines.join("\n")),
// but rows are written as each page is read, so memory stays at one page.

export function csvEscape(v: unknown): string {
  const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const EVENT_CSV_COLS = [
  "id", "timestamp", "source_app", "session_id", "hook_event_type",
  "tool_name", "model_name", "is_error", "duration_ms",
  "input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens",
  "cost_usd", "error_text",
];

/** Text chunks of the export, in order. Pull-based: nothing is read ahead. */
export function* exportChunks(pages: Iterable<unknown[]>, fmt: string): Generator<string> {
  let first = true;
  if (fmt === "csv") {
    yield EVENT_CSV_COLS.join(",");
    for (const page of pages) {
      let out = "";
      for (const r of page) out += "\n" + EVENT_CSV_COLS.map((c) => csvEscape((r as any)[c])).join(",");
      yield out;
    }
    return;
  }
  for (const page of pages) {
    let out = "";
    for (const r of page) {
      out += (first ? "[\n  " : ",\n  ") + JSON.stringify(r, null, 2).replace(/\n/g, "\n  ");
      first = false;
    }
    yield out;
  }
  yield first ? "[]" : "\n]";
}

export function exportStream(pages: Iterable<unknown[]>, fmt: string): ReadableStream<Uint8Array> {
  const it = exportChunks(pages, fmt);
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      const n = it.next();
      if (n.done) ctrl.close();
      else ctrl.enqueue(enc.encode(n.value));
    },
    cancel() {
      it.return(undefined);
    },
  });
}
