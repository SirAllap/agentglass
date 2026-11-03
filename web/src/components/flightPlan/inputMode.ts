/*
 * Whether the last thing the person did was press a key. A keyboard action does
 * not animate (nobody watches a card fade in that they just opened with Enter),
 * so what fades reads this. One listener for the page, installed once.
 */
let viaKey = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => { viaKey = true; }, true);
  window.addEventListener("pointerdown", () => { viaKey = false; }, true);
}
export const lastWasKey = (): boolean => viaKey;
