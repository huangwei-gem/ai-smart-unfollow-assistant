var p = document.getElementById('aiuf-root');
JSON.stringify({ panel: !!p, txt: p ? p.innerText.slice(0, 250) : '' });
