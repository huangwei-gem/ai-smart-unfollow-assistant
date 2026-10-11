var p = document.getElementById('aiuf-root');
var sels = [...p.querySelectorAll('select[data-role="cat"]')].map(s => s.value);
var unsorted = sels.filter(v => v === '未分类').length;
JSON.stringify({ total: sels.length, assigned: sels.length - unsorted, first5: sels.slice(0, 5) });
