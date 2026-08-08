/** localStorage, so a QA run can seed a paired host and reach every screen. */
export const WHEN_UNLOCKED = "whenUnlocked";

export async function getItemAsync(key: string): Promise<string | null> {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}
export async function setItemAsync(key: string, value: string): Promise<void> {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* private mode */ }
}
export async function deleteItemAsync(key: string): Promise<void> {
  try { globalThis.localStorage?.removeItem(key); } catch { /* private mode */ }
}
