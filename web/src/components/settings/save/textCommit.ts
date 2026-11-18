// Text/number field commit rules: blur or Enter saves, only when valid;
// Escape cancels; a bad value shows its error and is not saved; a good save
// shows "Saved" for 2 s. No Save button, no per-keystroke save.
import { realClock, SAVED_MS, type Clock } from "./clock.ts";

/** Return an error message, or null when the value is fine. */
export type Validate = (v: string) => string | null;

export type TextCommitState = { draft: string; error: string | null; saved: boolean };

export function createTextCommit(opts: {
  value: string;
  validate?: Validate;
  save: (v: string) => void;
  onChange?: (s: TextCommitState) => void;
  clock?: Clock;
}) {
  const clock = opts.clock ?? realClock;
  let committed = opts.value;
  let state: TextCommitState = { draft: opts.value, error: null, saved: false };
  let timer: unknown = null;
  const set = (p: Partial<TextCommitState>) => { state = { ...state, ...p }; opts.onChange?.(state); };
  const clearTimer = () => { if (timer != null) clock.clear(timer); timer = null; };

  return {
    get state() { return state; },
    /** The stored value changed from outside (undo, other window). */
    sync(v: string) {
      // Echo of our own save (controlled parent): keep "Saved" and its timer.
      if (v === committed && state.draft === v && state.saved) return;
      committed = v; clearTimer(); set({ draft: v, error: null, saved: false });
    },
    type(v: string) { set({ draft: v, error: null, saved: false }); },
    /** Blur or Enter. */
    commit() {
      if (state.draft === committed) { set({ error: null }); return; }
      const err = opts.validate?.(state.draft) ?? null;
      if (err) { set({ error: err, saved: false }); return; }
      committed = state.draft;
      opts.save(state.draft);
      clearTimer();
      set({ error: null, saved: true });
      timer = clock.set(() => { timer = null; set({ saved: false }); }, SAVED_MS);
    },
    /** Escape. */
    cancel() { set({ draft: committed, error: null }); },
    dispose: clearTimer,
  };
}
