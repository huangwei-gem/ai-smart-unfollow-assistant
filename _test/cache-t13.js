var p = document.getElementById('aiuf-root');
var s = document.getElementById('aiuf-ai-stop');
JSON.stringify({
  running: s ? !s.disabled : null,
  progress: (p.querySelector('.aiuf-toolbar .aiuf-mini') || {}).textContent || '',
  progressbar: (p.querySelector('.aiuf-progress') || {}).style ? 'yes' : 'no'
});
