import type { FlowBlockId } from "./flowCopy.ts";
import { FlowIcon } from "./flowIcons.tsx";

/**
 * The glyph in a block's corner, from the mockup's own set. Centred by the
 * block's icon box rather than moved per glyph: every one of these is drawn in
 * the same square, so the accent stripe, the name and the chip line up down
 * the chain.
 */
export function roleIcon(id: FlowBlockId, size: number) {
  switch (id) {
    case "you": return <FlowIcon name="users" size={size} />;
    case "orchestrator": return <FlowIcon name="spark" size={size} />;
    case "scout": return <FlowIcon name="chart" size={size} />;
    case "builder": return <FlowIcon name="rover" size={size} />;
    case "reviewer": return <FlowIcon name="lens" size={size} />;
    case "verifier": return <FlowIcon name="preflight" size={size} />;
    case "gate": return <FlowIcon name="lock" size={size} />;
    case "fallback": return <FlowIcon name="undo" size={size} />;
  }
}
