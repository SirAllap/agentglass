export function limiter(concurrency: number) {
  let running = 0;
  const queue: (() => void)[] = [];

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running++;
    try {
      return await fn();
    } finally {
      running--;
      queue.shift()?.();
    }
  };
}
