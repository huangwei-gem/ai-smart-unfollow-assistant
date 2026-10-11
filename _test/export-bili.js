(async () => {
  // 从面板页面同源调 B站关注接口拿真实 uid/name/sign
  var myuid = 0;
  try {
    var r0 = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
    var j0 = await r0.json();
    myuid = j0.data && j0.data.mid;
  } catch (e) { return 'nav-fail:' + e.message; }
  if (!myuid) return 'not-login';
  var r = await fetch('https://api.bilibili.com/x/relation/followings?vmid=' + myuid + '&pn=1&ps=20', { credentials: 'include' });
  var j = await r.json();
  var accs = (j.data && j.data.list || []).map(function (it) {
    return { uid: String(it.mid), name: it.uname || '', sign: (it.sign || '').replace(/\s+/g, ' ').trim() };
  });
  return JSON.stringify(accs);
})()
