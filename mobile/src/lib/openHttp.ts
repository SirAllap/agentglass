/*
 * Open a web page in the system browser, and nothing else. See model/httpUrl.ts
 * for why a button must not pass a field's address to `Linking.openURL` as is.
 * Returns whether it tried: a caller with a fallback (open-pr.ts) asks, the
 * rest ignore it.
 */
import { Linking } from "react-native";
import { httpUrl } from "../model/httpUrl.ts";

export function openHttp(raw: string | null | undefined): boolean {
  const url = httpUrl(raw);
  if (!url) return false;
  void Linking.openURL(url).catch(() => { /* no app for it */ });
  return true;
}
