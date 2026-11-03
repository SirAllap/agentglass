// Which branches the guardrails treat as shared, shared by the server (which
// refuses a hard reset on one) and the dock (which shuts the button and says why).

/** main and master always, plus the comma-joined names stored in `agx.protectedbranches`. */
export const protectedList = (configOutput: string): string[] =>
  [...new Set(["main", "master", ...configOutput.split(",").map((n) => n.trim()).filter(Boolean)])];

export const isProtectedBranch = (list: readonly string[], branch: string | undefined): boolean =>
  !!branch && list.includes(branch);
