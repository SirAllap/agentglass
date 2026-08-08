export async function setStringAsync(text: string): Promise<boolean> {
  console.info("[shim] copied:", text);
  return true;
}
