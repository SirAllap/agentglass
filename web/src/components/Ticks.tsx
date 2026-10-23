import type { ReactNode } from "react";
import { splitTicks } from "../lib/ticks.ts";

/** A string with `backticks` drawn as code; anything that is not a string passes through untouched. */
export function Ticks({ children }: { children?: ReactNode }): ReactNode {
  if (typeof children !== "string" || !children.includes("`")) return children;
  return splitTicks(children).map((r, i) => (r.code ? <code key={i} className="agx-ticks">{r.text}</code> : r.text));
}
