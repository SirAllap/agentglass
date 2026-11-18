import { useEffect, useId, useRef, useState } from "react";
import { INPUT, INPUT_STYLE } from "../../workspace/Chrome.tsx";
import { createTextCommit, type TextCommitState, type Validate } from "./textCommit.ts";

export function TextCommitField({ value, onSave, validate, label, placeholder, mono }: {
  value: string;
  onSave: (v: string) => void;
  validate?: Validate;
  label: string;
  placeholder?: string;
  mono?: boolean;
}) {
  const [s, setS] = useState<TextCommitState>({ draft: value, error: null, saved: false });
  const ref = useRef<ReturnType<typeof createTextCommit> | null>(null);
  const latest = useRef({ validate, onSave });
  latest.current = { validate, onSave };
  if (!ref.current) {
    ref.current = createTextCommit({
      value,
      validate: (v) => latest.current.validate?.(v) ?? null,
      save: (v) => latest.current.onSave(v),
      onChange: setS,
    });
  }
  const c = ref.current;
  const errId = useId();
  useEffect(() => { c.sync(value); }, [value, c]);
  useEffect(() => () => c.dispose(), [c]);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {s.saved && <span role="status" className="text-[11px] font-medium" style={{ color: "var(--text3)" }}>Saved</span>}
        <input
          aria-label={label}
          aria-invalid={s.error ? true : undefined}
          aria-describedby={s.error ? errId : undefined}
          value={s.draft}
          placeholder={placeholder}
          onChange={(e) => c.type(e.target.value)}
          onBlur={() => c.commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); c.commit(); }
            else if (e.key === "Escape") { e.preventDefault(); c.cancel(); }
          }}
          className={`${INPUT} ${mono ? "font-mono" : ""}`}
          style={s.error ? { ...INPUT_STYLE, boxShadow: "inset 0 0 0 1px var(--error)" } : INPUT_STYLE}
        />
      </div>
      {s.error && <span id={errId} role="alert" className="text-[11px]" style={{ color: "var(--error)" }}>{s.error}</span>}
    </div>
  );
}
