var lw = document.getElementById('aiuf-logwrap');
var p = document.getElementById('aiuf-root');
JSON.stringify({
  logOpen: lw ? lw.open : null,
  logText: lw ? lw.innerText.slice(0, 400) : '',
  tail: p.innerText.slice(500, 900)
});
