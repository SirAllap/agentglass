/*
 * A refusal is an answer, and it is the answer until the question changes.
 *
 * Measured in the window's console: `GET /clickup/list?id=ORBIT` answered 400
 * and was asked again every few seconds for as long as the pull request's
 * sidebar stayed open. Nothing retried it on purpose: the request helper
 * already lets an HTTP error leave at once. The controls that ask are mounted
 * again whenever the card they sit on is re-read, and each mount asked the
 * same doomed question. So the memory belongs under the call, not in each
 * control: the same key while a request is in flight shares that request, a
 * 4xx is kept and handed back without a request, and a network failure or a
 * 5xx is forgotten at once so the next ask goes out (the helper underneath
 * has its own cold-start back-off).
 *
 * Ceiling: a refusal is kept for REFUSED_MS, not for ever, so a list that is
 * shared with the person a minute later is found without a reload. An answer
 * that succeeded is not kept here at all: the server holds those.
 */

/** How long a 4xx stands for the same key. */
export const REFUSED_MS = 5 * 60_000;

/** The status a rejected request carried, or 0 for a failure that never got an answer. */
export function refusalStatus(e: unknown): number {
  const m = e instanceof Error ? / → (\d{3})$/.exec(e.message) : null;
  return m ? Number(m[1]) : 0;
}

/** A 4xx is final for its input; anything else may be asked again. */
export function isFinalRefusal(e: unknown): boolean {
  const s = refusalStatus(e);
  return s >= 400 && s < 500 && s !== 408 && s !== 429;
}

export function finalAnswers<T>(ask: (key: string) => Promise<T>, now: () => number = Date.now): (key: string) => Promise<T> {
  const flying = new Map<string, Promise<T>>();
  const refused = new Map<string, { at: number; error: unknown }>();
  return (key) => {
    const no = refused.get(key);
    if (no) {
      if (now() - no.at < REFUSED_MS) return Promise.reject(no.error);
      refused.delete(key);
    }
    const going = flying.get(key);
    if (going) return going;
    const p = ask(key).then(
      (v) => { flying.delete(key); return v; },
      (e) => {
        flying.delete(key);
        if (isFinalRefusal(e)) { if (refused.size >= 64) refused.delete(refused.keys().next().value!); refused.set(key, { at: now(), error: e }); }
        throw e;
      },
    );
    flying.set(key, p);
    return p;
  };
}
