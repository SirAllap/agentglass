/** No-ops that resolve. The interesting path is "permission granted", because
 *  that is the one every other screen is rendered under. */
export const AndroidImportance = { HIGH: 4, MAX: 5, DEFAULT: 3 };
export const AndroidNotificationPriority = { MAX: "max", HIGH: "high" };
export const IosAuthorizationStatus = { PROVISIONAL: 3 };
export function setNotificationHandler(_: unknown): void {}
export async function setNotificationChannelAsync(_: string, __: unknown): Promise<void> {}
export async function getPermissionsAsync(): Promise<{ granted: boolean }> { return { granted: true }; }
export async function requestPermissionsAsync(): Promise<{ granted: boolean }> { return { granted: true }; }
export async function scheduleNotificationAsync(request: unknown): Promise<string> {
  // Logged rather than swallowed: a QA run should be able to SEE that a
  // notification would have been raised.
  console.info("[shim] notification:", JSON.stringify(request));
  return "shim";
}
