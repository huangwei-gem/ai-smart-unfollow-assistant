// ============================================================
// B站适配：content/bilibili.js
// 数据来源：
//   关注列表  GET https://api.bilibili.com/x/relation/followings?vmid={uid}&pn={page}&ps=50
//   取关      POST https://api.bilibili.com/x/relation/modify  (act=2, csrf=bili_jct)
//   关系统计  GET https://api.bilibili.com/x/relation/stat?vmid={uid}
// 登录态与 csrf 均由页面 cookie 提供（DedeUserID / bili_jct）。
// ============================================================

(function () {
  'use strict';
  const U = window.AIUnfollow.utils;

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function getMyUid() {
    const v = getCookie('DedeUserID');
    return v && /^\d+$/.test(v) ? v : null;
  }

  // ---------- wbi 签名（B站 2023 起空间接口必需）+ 简版 md5 ----------
  function md5(str) {
    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function ad(x, y) { var l = (x & 0xFFFF) + (y & 0xFFFF), m = (x >> 16) + (y >> 16) + (l >> 16); return (m << 16) | (l & 0xFFFF); }
    function cvb(s) { var b = [], i; for (i = 0; i < s.length * 8; i += 8) b[i >> 5] |= (s.charCodeAt(i / 8) & 0xFF) << (i % 32); return b; }
    function cmn(q, a, b, x, s, t) { return ad(rl(ad(ad(a, q), ad(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
    function core(x, len) {
      x[len >> 5] |= 0x80 << ((len) % 32); x[(((len + 64) >>> 9) << 4) + 14] = len;
      var i, olda, oldb, oldc, oldd, a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
      for (i = 0; i < x.length; i += 16) {
        olda = a; oldb = b; oldc = c; oldd = d;
        a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586); c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
        a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426); c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
        a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417); c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
        a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101); c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
        a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632); c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
        a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083); c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
        a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690); c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
        a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784); c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
        a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463); c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
        a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353); c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
        a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222); c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
        a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835); c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
        a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415); c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
        a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606); c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
        a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744); c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
        a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379); c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
        a = ad(a, olda); b = ad(b, oldb); c = ad(c, oldc); d = ad(d, oldd);
      }
      return [a, b, c, d];
    }
    function hx(n) { var s = '', j; for (j = 0; j < 4; j++) s += ('0' + ((n >> (j * 8)) & 0xFF).toString(16)).slice(-2); return s; }
    var x = core(cvb(unescape(encodeURIComponent(str))), str.length * 8);
    return x.map(hx).join('');
  }

  const WBI_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
  let wbiMixin = null; // { key, t } 缓存 1 小时
  async function getWbiMixin() {
    if (wbiMixin && Date.now() - wbiMixin.t < 3600000) return wbiMixin.key;
    const nav = await U.fetchJson('https://api.bilibili.com/x/web-interface/nav', { method: 'GET', credentials: 'include' }, 10000);
    const img = nav.json && nav.json.data && nav.json.data.wbi_img;
    if (!img) throw new Error('获取 wbi 密钥失败');
    const raw = img.img_url.split('/').pop().split('.')[0] + img.sub_url.split('/').pop().split('.')[0];
    const key = WBI_TAB.map((i) => raw[i]).join('').slice(0, 32);
    wbiMixin = { key, t: Date.now() };
    return key;
  }

  /** wbi 签名 GET（供空间接口使用） */
  async function wbiGet(apiPath, params, timeout) {
    const mixin = await getWbiMixin();
    const p = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
    const qs = Object.keys(p).sort()
      .map((k) => { const v = String(p[k]).replace(/[!'()*]/g, ''); return encodeURIComponent(k) + '=' + encodeURIComponent(v); })
      .join('&');
    const w_rid = md5(qs + mixin);
    return U.fetchJson(`${apiPath}?${qs}&w_rid=${w_rid}`, { method: 'GET', credentials: 'include' }, timeout);
  }

  // 近期视频标题缓存（storage 层，避免重复请求；3 天过期）
  const VID_TTL = 3 * 24 * 3600 * 1000;
  let vidMem = null;
  async function loadVidCache() {
    if (vidMem) return vidMem;
    try {
      const k = 'aiuf_vidcache_bilibili';
      const d = await chrome.storage.local.get(k);
      vidMem = d[k] || {};
    } catch (_) { vidMem = {}; }
    return vidMem;
  }
  function saveVidCache() {
    try { chrome.storage.local.set({ aiuf_vidcache_bilibili: vidMem }).catch(() => {}); } catch (_) {}
  }

  /** 抓取一个 UP 主近期视频标题（带“N天前”前缀），失败返回 null（容忍） */
  async function fetchRecentVideos(uid, count = 3) {
    try {
      const cache = await loadVidCache();
      const hit = cache[uid];
      if (hit && Date.now() - hit.t < VID_TTL) return hit.r;
      const r = await wbiGet('https://api.bilibili.com/x/space/wbi/arc/search',
        { mid: uid, ps: Math.max(count, 5), tid: 0, pn: 1, keyword: '', order: 'pubdate', platform: 'web', web_location: 1550101, order_avoided: true },
        12000);
      const vlist = r.json && r.json.data && r.json.data.list && Array.isArray(r.json.data.list.vlist)
        ? r.json.data.list.vlist : [];
      const now = Date.now() / 1000;
      const titles = vlist.slice(0, count).map((v) => {
        const days = v.created ? Math.max(0, Math.round((now - v.created) / 86400)) : null;
        return (days !== null ? `${days}天前 ` : '') + String(v.title || '').slice(0, 40);
      });
      if (titles.length) { cache[uid] = { r: titles, t: Date.now() }; saveVidCache(); }
      return titles.length ? titles : null;
    } catch (_) {
      return null; // 视频信号是加分项，失败不阻塞主流程
    }
  }

  const adapter = {
    detect() {
      return location.hostname.endsWith('bilibili.com');
    },

    isSupportedPage() {
      // 自己的空间页即可：可发 API（带 cookie），无需停留在关注管理页
      return this.detect() && !!getMyUid();
    },

    pageHint() {
      if (!this.detect()) return null;
      if (!getMyUid()) return '未检测到 B站 登录态，请先在 bilibili.com 登录。';
      return 'B站 就绪。直接在本页点击「抓取关注列表」即可（无需进入关注管理页）。';
    },

    /** 抓取全部关注列表
     * 参考 Bilibili_UnFollow 项目验证过的用法：
     *   1) GET /x/relation/tags 拿分组列表
     *   2) GET /x/relation/tag?tagid=&pn=&ps=50 逐组翻页（能拿全量，含特别关注）
     * 任一环节失败则回退到 /x/relation/followings 翻页。
     */
    async fetchFollowing({ onProgress, maxPages = 100, signal } = {}) {
      const uid = getMyUid();
      if (!uid) throw new Error('未登录 B站，无法获取关注列表');

      const all = [];
      const seen = new Set();
      const PAGE_SIZE = 50;
      const push = (item) => {
        const mid = String(item.mid);
        if (seen.has(mid)) return;
        seen.add(mid);
        all.push({
          uid: mid,
          name: item.uname || ('用户' + mid),
          sign: (item.sign || '').trim(),
          avatar: item.face || '',
          raw: {
            vip: item.vip && item.vip.vipType > 0,
            official: item.official_verify && item.official_verify.type >= 0,
          },
        });
      };

      const progress = () => {
        if (onProgress) onProgress({ phase: 'fetch', done: all.length, total: null });
      };

      let total = null;
      try {
        const stat = await U.fetchJson(
          `https://api.bilibili.com/x/relation/stat?vmid=${uid}`,
          { method: 'GET', signal }, 10000
        );
        if (stat.json && stat.json.data && typeof stat.json.data.following === 'number') {
          total = stat.json.data.following;
        }
      } catch (_) { /* 只影响进度显示 */ }

      const relHeaders = { 'Referer': `https://space.bilibili.com/${uid}/fans/follow` };

      // ---------- 主路径：分组接口逐组抓取 ----------
      let usedTagApi = false;
      try {
        const tagsResp = await U.fetchJson(
          'https://api.bilibili.com/x/relation/tags',
          { method: 'GET', headers: relHeaders, signal }, 15000
        );
        const tags = tagsResp.json && tagsResp.json.code === 0 && Array.isArray(tagsResp.json.data)
          ? tagsResp.json.data : null;

        if (tags) {
          usedTagApi = true;
          for (const tag of tags) {
            for (let page = 1; page <= maxPages; page++) {
              if (signal && signal.aborted) throw new Error('用户中止');
              const r = await U.fetchJson(
                `https://api.bilibili.com/x/relation/tag?tagid=${tag.tagid}&pn=${page}&ps=${PAGE_SIZE}`,
                { method: 'GET', headers: relHeaders, signal }, 15000
              );
              if (!r.ok || !r.json || r.json.code !== 0) {
                throw new Error(`分组「${tag.name}」第 ${page} 页拉取失败`);
              }
              const list = (r.json.data && Array.isArray(r.json.data.list)) ? r.json.data.list : null;
              if (list === null) {
                // 接口变更/风控时可能返回 code=0 但 data 为空对象，视为失败以触发回退
                throw new Error(`分组「${tag.name}」第 ${page} 页数据为空`);
              }
              list.forEach(push);
              progress();
              if (list.length < PAGE_SIZE) break;
              await U.humanDelay(300, 700);
            }
          }
        }
      } catch (e) {
        if (/中止/.test(String(e && e.message))) throw e;
        usedTagApi = false; // 回退
      }

      // 分组接口若一无所获，或明显不完整（少于 stat.total），回退到 followings 全量补抓（seen 去重）
      if (usedTagApi && (all.length === 0 || (total !== null && all.length < total))) usedTagApi = false;

      // ---------- 回退路径：followings 接口翻页 ----------
      if (!usedTagApi) {
        for (let page = 1; page <= maxPages; page++) {
          if (signal && signal.aborted) throw new Error('用户中止');
          const r = await U.fetchJson(
            `https://api.bilibili.com/x/relation/followings?vmid=${uid}&pn=${page}&ps=${PAGE_SIZE}`,
            { method: 'GET', headers: relHeaders, signal },
            15000
          );
          if (!r.ok || !r.json) throw new Error(`B站接口请求失败（HTTP ${r.status}），请稍后重试`);
          const d = r.json;
          if (d.code !== 0) {
            if (d.code === -101) throw new Error('B站登录态已失效，请重新登录');
            throw new Error(`B站接口错误 code=${d.code}：${d.message || '未知错误'}`);
          }
          const list = (d.data && d.data.list) || [];
          list.forEach(push);
          if (onProgress) onProgress({ phase: 'fetch', done: all.length, total });
          if (list.length < PAGE_SIZE) break; // 最后一页
          await U.humanDelay(300, 700);
        }
      }

      if (onProgress && total) onProgress({ phase: 'fetch', done: all.length, total });
      return all;
    },

    /** 近期视频标题信号（仅 B站 支持；面板深度识别模式调用） */
    fetchRecentVideos,

    /** 取关一个用户 */
    async unfollow(account, { onLog } = {}) {
      const csrf = getCookie('bili_jct');
      if (!csrf) return { ok: false, message: '缺少 bili_jct cookie（请确认已登录）' };

      const body = new URLSearchParams();
      body.set('fid', account.uid);
      body.set('act', '2');          // 官方约定：1 = 关注，2 = 取关
      body.set('re_src', '11');
      body.set('csrf', csrf);
      body.set('csrf_token', csrf);

      const r = await U.fetchJson('https://api.bilibili.com/x/relation/modify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }, 15000);

      const d = r.json;
      if (r.ok && d && d.code === 0) {
        if (onLog) onLog(`已取关 ${account.name}`);
        return { ok: true, message: 'ok' };
      }
      const msg = d ? `code=${d.code} ${d.message || ''}` : `HTTP ${r.status}`;
      return { ok: false, message: msg };
    },
  };

  window.AIUnfollow.registerPlatform('bilibili', adapter);
})();
