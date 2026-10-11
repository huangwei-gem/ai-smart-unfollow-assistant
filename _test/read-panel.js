(() => {
  const p = document.querySelector('.aiuf-panel');
  return JSON.stringify({
    panel: !!p,
    body: p ? p.textContent.replace(/\s+/g, ' ').slice(0, 250) : 'no panel',
  });
})()
