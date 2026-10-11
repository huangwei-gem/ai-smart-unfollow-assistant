var stop = document.getElementById('aiuf-ai-stop');
var run = document.getElementById('aiuf-ai-run');
var p = document.getElementById('aiuf-root');
var sels = [...p.querySelectorAll('select[data-role="cat"]')].map(s => s.value);
JSON.stringify({
  running: stop ? !stop.disabled : null,
  runText: run ? run.textContent : null,
  cats: sels,
  groups: [...p.querySelectorAll('.aiuf-group-h, .aiuf-cat-h')].map(e => e.textContent.trim()).slice(0, 6)
});
