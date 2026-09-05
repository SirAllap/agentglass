(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title) === 'Settings');
  btn.click();
  await sleep(700);
  const navs = [...document.querySelectorAll('aside button')].filter((b) => b.textContent.trim() && !b.textContent.includes('Back to app'));
  const out = [];
  for (const n of navs) {
    const name = n.textContent.replace(/STATE|\d+$/g, '').trim();
    n.click();
    await sleep(320);
    const col = document.querySelector('.agx-settings-col');
    if (!col) { out.push({ name, err: 'no column' }); continue; }
    const secs = col.querySelectorAll('.agx-settings-section');
    // Anything that is a big block of rows but is NOT inside a drawn section.
    const rows = col.querySelectorAll('.agx-settings-row');
    let orphan = 0;
    for (const r of rows) if (!r.closest('.agx-settings-section')) orphan++;
    const cs = secs.length ? getComputedStyle(secs[0]) : null;
    out.push({
      name,
      sections: secs.length,
      titled: [...secs].filter((x) => x.querySelector(':scope > .agx-settings-head, :scope > .panel-eyebrow')).length,
      rows: rows.length,
      orphanRows: orphan,
      cardBg: cs ? cs.backgroundColor : null,
      height: Math.round(col.getBoundingClientRect().height),
    });
  }
  return JSON.stringify(out);
})()
