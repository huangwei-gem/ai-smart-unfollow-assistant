(() => {
  const ball = document.querySelector('.aiuf-ball');
  const panel = document.querySelector('.aiuf-panel');
  return JSON.stringify({
    ball: !!ball,
    panel: !!panel,
    text: panel ? panel.textContent.slice(0, 150) : (document.body ? document.body.textContent.slice(0, 80) : 'no body'),
  });
})()
