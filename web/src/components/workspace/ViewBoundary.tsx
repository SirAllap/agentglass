/*
 * ONE VIEW FALLING OVER MUST NOT TAKE THE APP WITH IT.
 *
 * React unmounts the whole tree when a render throws and nothing above catches
 * it. In this app the whole tree is the rail, the top bar, every other view,
 * and — because `KEEP_RUNNING` keeps them mounted — the terminal's pty sockets
 * and the browser's tabs. So a single `undefined.map` in one panel has twice
 * in a month produced the same symptom: a black window, with the app running
 * and nothing on screen to say what happened.
 *
 * The dashboard already had a boundary, from `LazyPanel`, and that one is about
 * a chunk that would not load. This is the other half: a view that loaded fine
 * and threw while rendering. Both remount by key, for the same reason — React
 * will not re-run a component that threw unless the element is new.
 *
 * What it shows is deliberately the error's own message rather than "something
 * went wrong". The person reading it is the one who will fix it, and a black
 * window taught nobody anything.
 */
import React from "react";

type Props = { children: React.ReactNode; label: string };
type State = { failed: boolean; message: string; attempt: number };

export class ViewBoundary extends React.Component<Props, State> {
  state: State = { failed: false, message: "", attempt: 0 };

  static getDerivedStateFromError(err: unknown): Partial<State> {
    return { failed: true, message: err instanceof Error ? err.message : String(err) };
  }

  render() {
    if (!this.state.failed) {
      return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
    }
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-[13px] t-dim">{this.props.label} stopped drawing.</div>
        {/* The message, in the app's monospace, because it is a stack's worth of
            information compressed to one line and the reader is a developer. */}
        <code className="max-w-[70ch] text-[12px] t-dim2 break-words">{this.state.message}</code>
        <button
          type="button"
          className="agx-btn px-3 py-1.5 text-[12px]"
          onClick={() => this.setState((s) => ({ failed: false, message: "", attempt: s.attempt + 1 }))}
        >
          Reload this view
        </button>
        <div className="text-[11px] t-dim2">The other views, and anything running in them, are untouched.</div>
      </div>
    );
  }
}
