(async () => {
  const r = await fetch('/aweme/v1/creator/relation/following/list/?aid=2906&app_name=aweme_creator_platform&device_platform=web&cursor=0&count=1', { credentials: 'include' });
  const j = await r.json();
  const u = j.user_info_list && j.user_info_list[0];
  if (!u) return 'NO_USER:' + JSON.stringify(j).slice(0, 300);
  const out = { keys: Object.keys(u) };
  for (const k of Object.keys(u)) {
    out[k] = typeof u[k] === 'object' ? JSON.stringify(u[k]).slice(0, 120) : String(u[k]).slice(0, 120);
  }
  return JSON.stringify(out);
})()
