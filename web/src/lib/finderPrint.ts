// Print a file from the finder: the page the server already serves for the
// preview goes into a frame nobody sees, and that frame is printed. The page
// is the browser's own, so a text file prints as text, an image as an image and
// a PDF as a PDF; a type the browser cannot show prints a blank page, and the
// caller is told so before it asks (see printable).

/** Whether the browser can draw it, so that printing it is worth a sheet. */
export function printable(name: string): boolean {
  return /\.(txt|md|json|ya?ml|toml|csv|log|ts|tsx|js|jsx|py|rs|go|sh|css|html?|xml|png|jpe?g|gif|webp|svg|pdf)$/i.test(name);
}

/** The server sends the preview with `Content-Security-Policy: sandbox`, and a sandboxed frame may not print: so the bytes are fetched and framed from a blob, which carries no policy of its own. */
export async function printUrl(url: string): Promise<void> {
  const blob = await (await fetch(url)).blob();
  const href = URL.createObjectURL(blob);
  const f = document.createElement("iframe");
  f.setAttribute("aria-hidden", "true");
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  f.onload = () => {
    try { f.contentWindow?.focus(); f.contentWindow?.print(); } finally { setTimeout(() => { f.remove(); URL.revokeObjectURL(href); }, 60_000); }
  };
  f.src = href;
  document.body.appendChild(f);
}
