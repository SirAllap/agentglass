/*
 * A view that arrives in its own chunk, and what happens when it does not.
 *
 * Code-splitting a panel is only free if the fetch always succeeds, and here it
 * does not always succeed: the bundle is served over HTTP by the sidecar, and
 * the LAN and Tailscale companions load the same one over a link that drops.
 * A bare `<Suspense>` around a lazy import turns that into a spinner that never
 * ends — a view permanently replaced by a loading state, with no way back short
 * of reloading the whole app.
 *
 * So the boundary is part of the split, not an extra. It says what happened and
 * offers the retry, which is the only action there is: the chunk is one request
 * away and the reason it failed is usually already over.
 */
import React from "react";

type Props = { children: React.ReactNode; label: string };
type State = { failed: boolean; attempt: number };

class ChunkBoundary extends React.Component<Props, State> {
  state: State = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-[12px] t-dim2">
        <div>{this.props.label} could not be loaded.</div>
        <button
          type="button"
          className="agx-btn px-3 py-1.5 text-[12px]"
          // A new key remounts the subtree, which retries the import. React
          // caches a REJECTED lazy component, so the retry has to be a fresh
          // element rather than the same one rendered again.
          onClick={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))}
        >
          Try again
        </button>
      </div>
    );
  }
}

/** A lazily-loaded panel: the boundary, the spinner-free fallback, and the
 *  panel itself. The fallback is deliberately blank — this is a view that fills
 *  the screen, and a full-screen spinner for a local fetch that takes a frame
 *  reads as a flash, not as progress. */
export function LazyPanel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <ChunkBoundary label={label}>
      <React.Suspense fallback={<div className="h-full" />}>{children}</React.Suspense>
    </ChunkBoundary>
  );
}
