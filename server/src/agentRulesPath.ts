import { win32 } from "node:path";

/** Rule scopes must be absolute before Git or the filesystem sees them.
 * win32.isAbsolute alone also accepts drive-relative roots such as \foo;
 * require a drive plus separator or a complete UNC server/share instead.
 * Reject traversal rather than silently choosing a different project.
 */
export function isRuleRoot(value: unknown, allowBase = true): value is string {
  if (typeof value !== "string" || !value || value.includes("\0")) return false;
  if (value === "*") return allowBase;
  if (value.split(/[\\/]/).some((part) => part === "." || part === "..")) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("\\\\")) return /^\\\\[^\\/?]+[\\/][^\\/]+(?:[\\/]|$)/.test(value);
  return value.startsWith("/");
}

/** Use the host's native spelling for Windows scopes, matching config and
 * Git's dirname result, so either slash style finds the same non-repo rules.
 */
export function rulePathSpelling(value: string): string {
  if (process.platform === "win32" && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//"))) {
    const path = win32.normalize(value);
    return path.length > win32.parse(path).root.length ? path.replace(/[\\/]+$/, "") : path;
  }
  return value.replace(/\/+$/, "") || "/";
}
