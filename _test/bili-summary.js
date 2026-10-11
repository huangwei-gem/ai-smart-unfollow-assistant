(() => {
  const p = document.querySelector('.aiuf-panel');
  if (!p) return JSON.stringify({ panel: false });
  const txt = p.textContent.replace(/\s+/g, ' ');
  const cats = {};
  for (const m of txt.matchAll(/(常看博主|可能认识|僵尸号|营销号|不感兴趣|未分类)（(\d+) 人/g)) cats[m[1]] = +m[2];
  const names = [...p.querySelectorAll('.aiuf-acct .nm, .aiuf-row .nm')].map(n => n.textContent.trim()).slice(0, 12);
  const unfollowBtn = !!document.querySelector('#aiuf-unfollow, .aiuf-unfollow, [class*="unfollow"]');
  const dropdowns = p.querySelectorAll('select').length;
  const checked = p.querySelectorAll('input[type="checkbox"]:checked').length;
  return JSON.stringify({ cats, names, unfollowBtn, dropdowns, checked });
})()
