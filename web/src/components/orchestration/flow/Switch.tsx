/*
 * The house switch: a button with the switch role, so a keyboard and a reader
 * both reach it. Shared by the worker editor, the conditions panel and the rule
 * editor, which each used to import it from the old side panel.
 */
export function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className="fe-switch" data-on={on ? "" : undefined} onClick={() => onChange(!on)}>
      <span className="fe-track" />
    </button>
  );
}
