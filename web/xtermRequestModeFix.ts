/* esbuild's minifier breaks xterm 6.0.0's `let r; (P => ...)(r ||= {})` in requestMode: it drops the
   `let` and keeps an assignment to an undeclared name, so a terminal that answers a DECRQM query
   (Claude Code does, on start) threw "s is not defined" in the built app. Writing the assignment out
   avoids the pattern: the object is created at the `let` and passed as it is. Drop this when xterm or esbuild is past it. */
export const xtermRequestModeFix = {
  name: "xterm-request-mode-fix",
  transform(code: string, id: string) {
    if (!/@xterm[\\/]xterm[\\/]lib[\\/]xterm\.mjs/.test(id) || !code.includes("let r;(P=>(P[P.NOT_RECOGNIZED")) return null;
    return code.replaceAll("let r;(P=>(P[P.NOT_RECOGNIZED", "let r={};(P=>(P[P.NOT_RECOGNIZED").replaceAll("(r||={})", "(r)");
  },
};
