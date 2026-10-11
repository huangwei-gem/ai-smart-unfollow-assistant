(async () => {
  let cursor = 0;
  const stats = [];
  for (let p = 0; p < 5; p++) {
    const r = await fetch('/aweme/v1/creator/relation/following/list/?aid=2906&app_name=aweme_creator_platform&device_platform=web&cursor=' + cursor + '&count=20', { credentials: 'include' });
    const j = await r.json();
    const l = j.user_info_list || [];
    const m = l.filter(u => u.each_follow === true || u.each_follow === 'true').length;
    stats.push('page' + (p + 1) + ': ' + l.length + '人, 互关' + m);
    if (!j.has_more || !l.length) break;
    cursor = j.cursor;
  }
  return stats.join(' | ');
})()
