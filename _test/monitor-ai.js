(() => {
  const p = document.querySelector('.aiuf-panel');
  if (!p) return JSON.stringify({ panel: false });
  const txt = p.textContent.replace(/\s+/g, ' ');
  const progress = (txt.match(/AI 分析中… (\d+)\/(\d+)/) || [])[0] || '';
  const logwrap = document.querySelector('#aiuf-logwrap');
  const logs = logwrap ? [...logwrap.querySelectorAll('li,div,.aiuf-logline')].map(n => n.textContent.trim()).filter(Boolean).slice(-8) : [];
  const errs = [...p.querySelectorAll('.aiuf-err')].map(n => n.textContent.trim());
  const done = /AI 分析完成|分析完成/.test(txt);
  return JSON.stringify({ progress, done, errs, logs });
})()
