(async () => {
  const r0 = await fetch('/aweme/v1/creator/relation/following/list/?aid=2906&app_name=aweme_creator_platform&device_platform=web&cursor=0&count=1', { credentials: 'include' });
  const j0 = await r0.json();
  const uid = encodeURIComponent(j0.user_info_list[0].user_id);
  const candidates = [
    '/aweme/v1/creator/relation/following/detail/?user_id=' + uid,
    '/aweme/v1/creator/relation/user/detail/?user_id=' + uid,
    '/aweme/v1/creator/data/user/detail/?user_id=' + uid,
    '/aweme/v1/creator/relation/following/user_profile/?user_id=' + uid,
    'https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=' + uid,
  ];
  const out = [];
  for (const c of candidates) {
    try {
      const r = await fetch(c, { credentials: 'include' });
      const t = await r.text();
      let head = t.slice(0, 150).replace(/\s+/g, ' ');
      let keys = '';
      try { const jj = JSON.parse(t); keys = Object.keys(jj).join(','); const uk = (jj.user||jj.data||jj.user_info); if (uk) keys += ' | user keys: ' + Object.keys(uk).join(','); } catch (e) {}
      out.push(r.status + ' ' + c.slice(0, 70) + ' || keys: ' + keys.slice(0, 200) + ' || ' + head);
    } catch (e) { out.push('ERR ' + c.slice(0, 70) + ' ' + e.message); }
  }
  return out.join('\n');
})()
