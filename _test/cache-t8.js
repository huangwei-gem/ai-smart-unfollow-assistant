var p = document.getElementById('aiuf-root');
var lw = p ? p.querySelector('.aiuf-logwrap') : null;
JSON.stringify({
  busy: !!document.getElementById('aiuf-ai-stop'),
  logOpen: lw ? lw.open : 'absent',
  logText: lw ? lw.innerText.slice(0, 500) : ''
});
