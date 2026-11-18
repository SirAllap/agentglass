// One socket frame tells the Machine dialog the disk report moved; it re-reads the kept scan once. Never on a clock.
const listeners = new Set<() => void>();
export function diskExplainChanged(): void { for (const fn of listeners) { try { fn(); } catch { /* one bad listener must not stop the rest */ } } }
export function onDiskExplainChanged(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
