/*
 * Back and forward through the folders the finder has been in, as Strata does
 * (Alt+Left, Alt+Right). Going somewhere new drops what was ahead; going to the
 * place you are already in changes nothing, so a refresh is not a step.
 */
export interface History { stack: string[]; at: number }

export const startHistory = (path: string): History => ({ stack: [path], at: 0 });

export function visit(h: History, path: string): History {
  if (h.stack[h.at] === path) return h;
  const stack = [...h.stack.slice(0, h.at + 1), path];
  // A long session keeps the last 200 places, which is more than anyone walks back through.
  return stack.length > 200 ? { stack: stack.slice(stack.length - 200), at: 199 } : { stack, at: stack.length - 1 };
}

export const canBack = (h: History): boolean => h.at > 0;
export const canForward = (h: History): boolean => h.at < h.stack.length - 1;
export const back = (h: History): History => (canBack(h) ? { ...h, at: h.at - 1 } : h);
export const forward = (h: History): History => (canForward(h) ? { ...h, at: h.at + 1 } : h);
export const here = (h: History): string => h.stack[h.at]!;
