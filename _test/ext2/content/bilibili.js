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
