/*
 * How far a screen has to rise to keep its bottom edge above the keyboard.
 *
 * The answer is the overlap, in window coordinates: where the view ends minus
 * where the keyboard starts. When Android resizes the window for the keyboard
 * the view has already shrunk and that comes out zero; when it does not (an
 * edge-to-edge window is not resized) it is exactly the part under the keys.
 * One expression, right either way — the same arithmetic as React Native's
 * KeyboardAvoidingView, but measured in the window. KeyboardAvoidingView
 * measures the view against its PARENT, so on a pushed screen the native
 * header's height is missing from it and the last 60 points stay hidden.
 *
 * Put the returned padding on the view the ref is attached to.
 */
import { useEffect, useRef, useState } from "react";
import { Keyboard, type View } from "react-native";

export function useKeyboardLift(): { ref: React.RefObject<View | null>; lift: number } {
  const ref = useRef<View>(null);
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      ref.current?.measureInWindow((_x, y, _w, h) => setLift(Math.max(0, Math.round(y + h - e.endCoordinates.screenY))));
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => setLift(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return { ref, lift };
}
