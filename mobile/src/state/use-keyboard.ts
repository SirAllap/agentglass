/*
 * Is the keyboard up?
 *
 * React Navigation asks the same question in `useIsKeyboardShown`, and answers
 * it with `keyboardDidShow`/`keyboardDidHide` on Android and the `Will` pair on
 * iOS. That split is not a preference: Android has no "will", and iOS fires
 * "did" after the animation, so a bar that waited for it would slide out from
 * under a keyboard that had already arrived.
 *
 * We ask it ourselves because their answer is locked inside their own tab bar
 * — `tabBarHideOnKeyboard` is read in BottomTabBar.js:121 and this app draws
 * its own bar (src/nav/TabBar.tsx), so the option is silently a no-op here.
 *
 * On Android these events fire whether or not the window resizes for the IME,
 * which is what makes them the right signal after edge-to-edge stopped the
 * resizing — see the comment in app/(tabs)/terminal.tsx.
 */
import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

export function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const subs = [
      Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () => setShown(true)),
      Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setShown(false)),
    ];
    return () => { for (const sub of subs) sub.remove(); };
  }, []);
  return shown;
}
