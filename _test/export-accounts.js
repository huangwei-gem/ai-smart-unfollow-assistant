(async () => {
  let cursor = 0;
  const accs = [];
  for (let p = 0; p < 1; p++) {
    const r = await fetch('/aweme/v1/creator/relation/following/list/?aid=2906&app_name=aweme_creator_platform&device_platform=web&cursor=' + cursor + '&count=20', { credentials: 'include' });
    const j = await r.json();
    for (const u of (j.user_info_list || [])) {
      accs.push({ uid: u.user_id, name: u.nickname, sign: (u.signature || '').replace(/\s+/g, ' ').trim() });
    }
  }
  return JSON.stringify(accs);
})()
