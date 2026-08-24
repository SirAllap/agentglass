/*
 * The recorder, for the QA harness.
 *
 * There is no microphone in a headless Chrome and nothing useful to invent for
 * one: a shim that returned audio would make the whole dictation path look
 * exercised when the only thing under test is that the screen mounts.
 *
 * So permission is refused, which is a real answer the caller already handles —
 * a phone where the microphone is denied — and the screen carries on.
 */
export const RecordingPresets = { HIGH_QUALITY: {} } as const;

export async function requestRecordingPermissionsAsync(): Promise<{ granted: boolean }> {
  console.info("[shim] no microphone here");
  return { granted: false };
}

export function useAudioRecorder(): {
  record: () => void;
  stop: () => Promise<void>;
  uri: string | null;
} {
  return { record: () => {}, stop: async () => {}, uri: null };
}

export async function setAudioModeAsync(): Promise<void> {}
