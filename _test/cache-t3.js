var p = document.getElementById('aiuf-root');
JSON.stringify({ logs: (p.innerText.match(/缓存命中[^\n]*|无缓存[^\n]*|秒级完成[^\n]*|分类完成[^\n]*|失败[^\n]*/g) || []), done: /分类完成/.test(p.innerText) });
