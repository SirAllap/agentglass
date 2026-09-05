(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(600);
  const small = [];
  for (const svg of document.querySelectorAll('svg')) {
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.width >= 14 && r.height >= 14) continue;
    const btn = svg.closest('button, a, [role=button]');
    const b = btn ? btn.getBoundingClientRect() : null;
    const onlyIcon = btn ? btn.textContent.trim().length === 0 : false;
    small.push({
      w: Math.round(r.width), h: Math.round(r.height),
      hit: b ? Math.round(b.width) + 'x' + Math.round(b.height) : 'none',
      onlyIcon,
      label: String((btn ? (btn.getAttribute('aria-label') || btn.title || '') : '')).slice(0, 30),
    });
  }
  const key = (s) => s.w + 'x' + s.h + '|' + s.hit + '|' + s.onlyIcon;
  const grouped = new Map();
  for (const s of small) {
    const k = key(s);
    if (!grouped.has(k)) grouped.set(k, { ...s, n: 0, labels: [] });
    const g = grouped.get(k); g.n++;
    if (s.label && g.labels.length < 3) g.labels.push(s.label);
  }
  return JSON.stringify([...grouped.values()].sort((a, b) => b.n - a.n).slice(0, 16));
})()
