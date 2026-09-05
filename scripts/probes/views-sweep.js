(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(600);
  const close = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Close');
  if (close) { close.click(); await sleep(400); }
  const rail = [...document.querySelectorAll('nav[role=tablist] button')];
  const out = [];
  for (const b of rail) {
    const name = (b.getAttribute('aria-label') || b.title || '').split('\n')[0].slice(0, 18);
    if (!name) continue;
    b.click();
    await sleep(700);
    // tones
    const seen = new Map();
    const walk = (el, d) => {
      if (d > 9) return;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 20000) return;
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)') seen.set(bg, (seen.get(bg) || 0) + Math.round(r.width * r.height / 1000));
      for (const c of el.children) walk(c, d + 1);
    };
    walk(document.body, 0);
    const all = [...seen.entries()].sort((a, b2) => b2[1] - a[1]);
    const total = all.reduce((n, x) => n + x[1], 0) || 1;
    // tiny icons
    let tiny = 0, tinyHit = 0;
    for (const svg of document.querySelectorAll('svg')) {
      const r = svg.getBoundingClientRect();
      if (!r.width || r.width >= 14) continue;
      tiny++;
      const btn = svg.closest('button, a, [role=button]');
      if (btn) { const q = btn.getBoundingClientRect(); if (q.width < 20 || q.height < 20) tinyHit++; }
    }
    out.push({ view: name, flat: Math.round((all[0] ? all[0][1] : 0) / total * 100), tones: all.length, tinyIcons: tiny, tinyHits: tinyHit });
  }
  return JSON.stringify(out);
})()
