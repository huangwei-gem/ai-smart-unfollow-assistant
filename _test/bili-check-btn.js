(() => {
  const p = document.querySelector('.aiuf-panel');
  const boxes = [...p.querySelectorAll('input[type="checkbox"]')];
  const row = boxes.find(b => { const t = b.closest('.aiuf-acct, .aiuf-row, div'); return t && /营销号|不感兴趣/.test(t.parentElement ? t.parentElement.textContent : ''); }) || boxes[boxes.length - 1];
  if (row && !row.checked) row.click();
  return new Promise(res => setTimeout(() => {
    const txt = document.querySelector('.aiuf-panel').textContent.replace(/\s+/g, ' ');
    const redBtn = [...document.querySelectorAll('.aiuf-panel button')].map(b => ({ t: b.textContent.trim(), id: b.id, cls: b.className, disabled: b.disabled })).filter(b => /取关|执行/.test(b.t));
    res(JSON.stringify({ checkedNow: [...document.querySelectorAll('.aiuf-panel input[type="checkbox"]:checked')].length, redBtn, txtTail: txt.slice(-120) }));
  }, 400));
})()
