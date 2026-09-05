(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(500);
  const seen = new Map();
  const walk = (el, d) => {
    if (d > 9) return;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 20000) return;
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)') {
      seen.set(bg, (seen.get(bg) || 0) + Math.round(r.width * r.height / 1000));
    }
    for (const c of el.children) walk(c, d + 1);
  };
  walk(document.body, 0);
  const all = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  const total = all.reduce((n, x) => n + x[1], 0);
  return JSON.stringify({ total, top: all.slice(0, 6).map(([c, n]) => [c, n, Math.round(n / total * 100) + '%']) });
})()
