import { applyOps, validateScene, type CanvasFrame, type CanvasOp, type CanvasScene } from "../../../shared/pluginCanvas.ts";

/**
 * The window's copy of one live canvas, and the only rule for changing it.
 *
 * Pure on purpose: there is no renderer in this project, so the decision "does
 * this frame follow what I have" lives where a test can call it. The socket
 * (canvasLive.ts) feeds frames in and the view (PluginCanvas.tsx) reads state
 * out; neither decides anything about order.
 *
 * The server owns `epoch` (a new one when the plugin restarts) and `version`
 * (one more per applied batch). A frame that does not follow what the window
 * holds is never guessed at: the answer is to ask again, and the server replies
 * with a whole snapshot, so the window never has to reconcile two histories.
 */
export interface CanvasState {
  epoch: number;
  version: number;
  scene: CanvasScene;
  running: boolean;
  /** The plugin, panel or scene is gone or unusable: the window says "not
   *  running" instead of drawing what it last had. */
  gone: boolean;
  /** Whether a snapshot has ever arrived. Ops before the first one cannot be
   *  applied to anything. */
  loaded: boolean;
}

export const EMPTY_CANVAS: CanvasState = { epoch: -1, version: -1, scene: [], running: false, gone: false, loaded: false };

export interface Reduced {
  state: CanvasState;
  /** The operations that were applied, as the reducer understood them (for
   *  the view to animate). Null for anything that replaced the scene whole. */
  applied: CanvasOp[] | null;
  /** The frame did not follow the state: send `subscribe` again. */
  resubscribe: boolean;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function reduceCanvas(state: CanvasState, frame: CanvasFrame): Reduced {
  switch (frame.type) {
    case "snapshot": {
      const scene = validateScene(frame.scene);
      // A snapshot that is not a scene is not something to half-draw, and not
      // final either: ask again (the hub spaces the asks out).
      if (!scene.ok || !isCount(frame.epoch) || !isCount(frame.version)) {
        return { state: { ...EMPTY_CANVAS, gone: true }, applied: null, resubscribe: true };
      }
      return {
        state: { epoch: frame.epoch, version: frame.version, scene: scene.value, running: frame.running === true, gone: false, loaded: true },
        applied: null,
        resubscribe: false,
      };
    }
    case "ops": {
      const follows = state.loaded && !state.gone && frame.epoch === state.epoch && frame.from === state.version && isCount(frame.to) && frame.to > frame.from;
      if (!follows) return { state, applied: null, resubscribe: true };
      const next = applyOps(state.scene, frame.ops);
      // The server already applied these; failing here means the window's copy
      // is not the server's. Ask for the truth instead of drawing a guess.
      if (!next.ok) return { state, applied: null, resubscribe: true };
      return { state: { ...state, scene: next.value.scene, version: frame.to }, applied: next.value.ops, resubscribe: false };
    }
    case "gone":
      return { state: { ...state, gone: true, running: false }, applied: null, resubscribe: false };
    default:
      return { state, applied: null, resubscribe: false };
  }
}
