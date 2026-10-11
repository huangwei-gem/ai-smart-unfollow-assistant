(async () => {
  const r = await fetch('/aweme/v1/creator/relation/following/list/?aid=2906&app_name=aweme_creator_platform&device_platform=web&cursor=0&count=20', { credentials: 'include' });
  const j = await r.json();
  const list = j.user_info_list || [];
  const rows = list.map(u => ({
    name: u.nickname,
    signFull: (u.signature || '').slice(0, 50),
    signLen: (u.signature || '').length,
    mutual: u.each_follow === true || u.each_follow === 'true',
  }));
  const mutualCnt = rows.filter(x => x.mutual).length;
  const longSign = rows.filter(x => x.signLen > 60).length;
  return JSON.stringify({ total: j.total_num, page: rows.length, mutualCnt, longSign, sample: rows.slice(0, 4) });
})()
