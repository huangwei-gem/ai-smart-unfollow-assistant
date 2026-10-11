var p = document.getElementById('aiuf-root');
var note = p.querySelector('.aiuf-hint');
var sels = [...p.querySelectorAll('select[data-role="cat"]')].map(s => s.value);
JSON.stringify({ note: note ? note.textContent.slice(0, 80) : '', cats: sels });
