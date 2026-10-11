var p = document.getElementById('aiuf-root');
var prog = p.querySelector('.aiuf-progress');
JSON.stringify({
  busy: !!document.getElementById('aiuf-ai-stop'),
  btnText: (document.getElementById('aiuf-ai-run') || {}).textContent || '',
  progText: (p.querySelector('.aiuf-toolbar .aiuf-mini') || {}).textContent || '',
  err: (p.querySelector('.aiuf-err') || {}).textContent || ''
});
