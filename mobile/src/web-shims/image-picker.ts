/*
 * The image picker, for the QA harness.
 *
 * There is no gallery in a headless Chrome and there is nothing useful to
 * stand in for one: a shim that invented a picture would make the upload path
 * look exercised when the only thing under test is that the screen mounts.
 *
 * So it cancels, which is a real answer the caller already handles — somebody
 * opening the picker and changing their mind — and the screen carries on.
 */
export type PermissionResponse = { granted: boolean };

export async function requestMediaLibraryPermissionsAsync(): Promise<PermissionResponse> {
  return { granted: false };
}

export async function launchImageLibraryAsync(): Promise<{ canceled: true }> {
  console.info("[shim] no gallery here — cancelled");
  return { canceled: true };
}

export async function launchCameraAsync(): Promise<{ canceled: true }> {
  console.info("[shim] no camera here — cancelled");
  return { canceled: true };
}

export const MediaTypeOptions = { Images: "Images" } as const;
