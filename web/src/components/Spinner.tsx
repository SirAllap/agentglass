/**
 * Something is happening.
 *
 * The panels here fetch on open — a card's members, a list's statuses — and an
 * empty box during those few hundred milliseconds is indistinguishable from a
 * box with nothing in it. Nobody waits in front of a blank menu; they press the
 * button again, or decide the feature is broken. Which is what happened with
 * the assignee picker.
 *
 * The glyph and the class are the ones GitPanel already spins, rather than a
 * second way to say the same thing: `animate-spin` is in the stylesheet, and a
 * bespoke ring would have meant a keyframe of its own for no gain.
 */
export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-[10.5px] ${className ?? "px-2.5 py-1.5"}`}
      style={{ color: "var(--text3)" }} role="status">
      <span aria-hidden className="inline-block animate-spin shrink-0">⟳</span>
      {label}
    </span>
  );
}
