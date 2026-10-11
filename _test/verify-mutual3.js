(async () => {
  let cursor = 0;
  const vals = {};
  let n = 0;
  for (let p = 0; p < 15; p++) {
    const r = await fetch('/aweme/v1/creator/relation/following/list/?aid=2906&app_name=aweme_creator_platform&device_platform=web&cursor=' + cursor + '&count=20', { credentials: 'include' });
    const j = await r.json();
    const l = j.user_info_list || [];
    for (const u of l) { const k = String(u.each_follow); vals[k] = (vals[k] || 0) + 1; n++; }
    if (!j.has_more || !l.length) break;
    cursor = j.cursor;
  }
  return JSON.stringify({ scanned: n, eachFollowValues: vals });
})()
