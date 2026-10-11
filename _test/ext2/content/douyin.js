// ============================================================
// 抖音适配：content/douyin.js（创作者平台方案）
// 参考开源实现 6r6/douyin-unfollow（Automa 工作流）验证过的路径：
//   https://creator.douyin.com/creator-micro/data/following/following
// 该页是官方「关注管理」表格：每行 昵称/抖音号/简介 + 「取消关注」按钮，
// 点击后弹确认框。抓取与取关都在本页完成，无需逐个访问主页。
//
// 说明：创作者平台需用抖音 APP 扫码登录一次。
// ============================================================

(function () {
  'use strict';
  const U = window.AIUnfollow.utils;

  const CREATOR_ORIGIN = 'https://creator.douyin.com';
  const MGMT_PATH = '/creator-micro/data/following/following';
  // 创作者平台关注列表分页接口（页面自身用的就是它，同源携带 Cookie，无需签名）
  const FOLLOW_API = '/aweme/v1/creator/relation/following/list/';

  const onCreator = () => location.hostname === 'creator.douyin.com';
  const onMainSite = () => location.hostname === 'www.douyin.com';

  function visibleText(el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function uidFromHref(href) {
    const m = String(href || '').match(/\/user\/([\w-]+)/);
    return m ? m[1] : null;
  }

  /** 等待选择器出现 */
  async function waitForSelector(selector, timeoutMs = 10000, interval = 250) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch (_) {}
      await U.sleep(interval);
    }
    return null;
  }

  /** 找到表格的可滚动容器（creator-micro 是内部滚动布局） */
  function findScrollContainer() {
    const table = document.querySelector('[class*="table"], [class*="Table"]');
    const candidates = [];
    let el = table || document.body;
    while (el && el !== document.body.parentElement) {
      if (el.scrollHeight > el.clientHeight + 50) candidates.push(el);
      el = el.parentElement;
    }
    // 优先离表格最近的滚动容器
    return candidates[0] || document.scrollingElement || document.body;
  }

  /** 解析页面上的关注总数（找不到返回 null） */
  function parseTotalFromText() {
    const text = document.body.innerText || '';
    const patterns = [
      /共\s*(\d+)\s*(?:个|位)?关注/,
      /关注\s*(\d+)/,
      /(\d+)\s*(?:个|位)?关注/,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > 0 && n < 100000) return n;
      }
    }
    return null;
  }

  /** 从一行 DOM 提取账号信息（不依赖混淆 class，按文本结构解析） */
  function parseRow(rowEl) {
    // uid：行内指向个人主页的链接
    let uid = null;
    let profileUrl = '';
    rowEl.querySelectorAll('a[href*="/user/"]').forEach((a) => {
      const u = uidFromHref(a.href);
      if (u && !uid) { uid = u; profileUrl = a.href; }
    });

    // 文本行解析：第一行通常是昵称，"抖音号：xxx" 单独一行，剩余当简介
    const lines = (rowEl.innerText || '')
      .split('\n').map(s => s.trim()).filter(Boolean);
    let name = '';
    let sign = '';
    let dyCode = '';
    for (const line of lines) {
      const codeM = line.match(/^[Ii][Dd][：:]|^抖音号[：:]/);
      if (codeM) { dyCode = line.replace(/^[Ii][Dd][：:]|^抖音号[：:]\s*/, ''); continue; }
      if (!name) { name = line; continue; }
      if (!sign && line !== name) sign = line;
    }

    // 关注状态：本页全部是已关注用户；若行内出现"关注"单字按钮说明已取关
    const stateText = visibleText(rowEl);
    const stillFollowed = /取消关注|已关注|互相关注/.test(stateText);

    return {
      uid: uid || ('name:' + name),
      name: name || ('抖音用户' + (dyCode || '').slice(0, 10)),
      sign: sign || '',
      avatar: '',
      raw: { url: profileUrl, dyCode, stillFollowed },
    };
  }

  /** 收集当前 DOM 里的所有行 */
  function collectRows() {
    // 行 = 包含「取消关注」或「已关注」文本、且长度合理的最小元素
    const all = document.querySelectorAll('tr, [class*="table-row"], [class*="tableRow"], li, div');
    const rows = [];
    const seen = new WeakSet();
    for (const el of all) {
      const t = el.innerText || '';
      if (!t || t.length > 400) continue;
      if (!/取消关注|已关注|互相关注/.test(t)) continue;
      // 保证是最小的行单元（不再包含另一个更小的行）
      const inner = el.querySelectorAll('tr, [class*="table-row"], [class*="tableRow"], li');
      let nested = false;
      for (const c of inner) {
        if (c !== el && /取消关注|已关注|互相关注/.test(c.innerText || '')) { nested = true; break; }
      }
      if (nested) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      rows.push(el);
    }
    return rows;
  }

  /** 找「下一页」分页按钮（存在且可用时返回）
   *  兼容三种形态：文本按钮（下一页/Next）、箭头字符（›）、图标类名（next/arrow/right） */
  function findNextPageButton() {
    const cands = document.querySelectorAll(
      'button, li, a, span, [class*="next" i], [class*="Next"], [aria-label*="next" i], [title*="下一页"]'
    );
    for (const el of cands) {
      const t = visibleText(el);
      const attr = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
      const cls = (el.className || '').toString();
      const hitText = t === '下一页' || t === 'Next' || t === '›' || t === '〉';
      const hitAttr = /next/i.test(attr) || /下一页/.test(attr);
      const hitCls = /(^|[\s_-])(next|arrow-right|chevron-right)($|[\s_-])/i.test(cls) && !/disabled/i.test(cls);
      if (hitText || hitAttr || hitCls) {
        // 图标类名命中时，要求它可点击（按钮/带 cursor 的元素），避免误中装饰元素
        if (hitCls && !hitText && !hitAttr && el.tagName !== 'BUTTON' && !/cursor|btn|item/i.test(cls)) continue;
        const disabled = el.disabled || /disabled|is-disabled/.test(el.className || '');
        if (!disabled) return el;
      }
    }
    return null;
  }

  const adapter = {
    detect() {
      return onCreator() || onMainSite();
    },

    isSupportedPage() {
      // 主站也可以打开（引导跳转），真正干活在创作者平台
      return this.detect();
    },

    pageHint() {
      if (onCreator()) {
        return '抖音创作者平台就绪。点击「抓取关注列表」将通过接口快速读取全部关注（含自动翻页）；如提示未登录，请用抖音 APP 扫码登录后刷新。';
      }
      if (onMainSite()) {
        return '当前在抖音主站。取关功能在创作者平台的「关注管理」页完成，点击下方按钮会自动跳转（需先用抖音 APP 扫码登录创作者平台）。';
      }
      return null;
    },

    /** 是否需要跳转到创作者平台 */
    needsRedirect() {
      return onMainSite();
    },

    goToCreatorPage() {
      location.href = CREATOR_ORIGIN + MGMT_PATH;
    },

    async ensureManagementPage() {
      if (!location.pathname.startsWith('/creator-micro/data/following')) {
        history.pushState({}, '', MGMT_PATH);
        window.dispatchEvent(new PopStateEvent('popstate'));
        await U.sleep(2500);
      }
      // 等表格出现（文本特征）
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (collectRows().length > 0) return true;
        await U.sleep(500);
      }
      return false;
    },

    /**
     * 接口直翻抓取（快）：同源 fetch 分页接口，cursor 链式翻页，每页 20 条。
     * 失败时抛错，由 fetchFollowing 回退到 DOM 滚动方案。
     */
    async fetchViaApi({ onProgress, signal, maxPages = 200 } = {}) {
      const accounts = [];
      const seen = new Set();
      let cursor = 0;
      let total = null;

      for (let page = 0; page < maxPages; page++) {
        if (signal && signal.aborted) throw new Error('用户中止');

        let j = null;
        try {
          const resp = await fetch(
            FOLLOW_API + '?aid=2906&app_name=aweme_creator_platform&device_platform=web&cursor=' + cursor + '&count=20',
            { credentials: 'include' }
          );
          if (resp.ok) j = await resp.json();
        } catch (_) {}
        const list = (j && Array.isArray(j.user_info_list)) ? j.user_info_list : null;
        if (list === null) {
          // 未登录 / 接口变更 / 风控：抛错走 DOM 兜底
          throw new Error('关注列表接口不可用（第 ' + (page + 1) + ' 页）');
        }
        if (total === null && j.total_num) total = j.total_num;

        for (const u of list) {
          const id = u.user_id || u.sec_uid;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          accounts.push({
            uid: id,
            name: u.nickname || '抖音用户',
            sign: (u.signature || '').replace(/\s+/g, ' ').trim(),
            avatar: u.avatar || '',
            raw: { viaApi: true, mutual: u.each_follow === true || u.each_follow === 'true' },
          });
        }
        if (onProgress) onProgress({ phase: 'fetch', done: accounts.length, total });

        // 翻页：以服务端返回的 has_more 为准；空页也视为到底
        if (!j.has_more || list.length === 0) break;
        cursor = j.cursor || cursor;
        await U.humanDelay(150, 400); // 轻微间隔，避免高频请求触发风控
      }

      if (!accounts.length) throw new Error('接口返回 0 个关注');
      return accounts;
    },

    /**
     * 抓取关注列表：优先接口直翻（秒级翻完所有页），
     * 接口不可用时回退到滚动 + 翻页按钮的 DOM 方案。
     */
    async fetchFollowing({ onProgress, maxPages = 5000, signal } = {}) {
      // 主路径：接口直翻
      try {
        const accounts = await this.fetchViaApi({ onProgress, signal });
        return accounts;
      } catch (_) {
        if (signal && signal.aborted) throw new Error('用户中止');
        if (onProgress) onProgress({ phase: 'fetch', done: 0, total: null, note: '接口抓取失败，改用页面滚动方式' });
      }

      // 兜底路径：滚动 + 解析表格 DOM
      const ready = await this.ensureManagementPage();
      if (!ready) {
        throw new Error('没有找到关注管理表格。请确认已在创作者平台用抖音 APP 扫码登录，并手动打开「关注管理」页后重试。');
      }

      const byKey = new Map(); // key -> account
      const originHref = location.href;
      let idleRounds = 0;
      let pagedToEnd = false;

      const collect = () => {
        for (const row of collectRows()) {
          const acc = parseRow(row);
          if (!byKey.has(acc.uid)) byKey.set(acc.uid, acc);
        }
      };

      for (let round = 0; round < 800 && byKey.size < maxPages; round++) {
        if (signal && signal.aborted) throw new Error('用户中止');

        collect();
        const totalKnown = parseTotalFromText();
        if (onProgress) onProgress({ phase: 'fetch', done: byKey.size, total: totalKnown });

        const before = byKey.size;
        const scroller = findScrollContainer();
        scroller.scrollBy ? scroller.scrollBy(0, scroller.clientHeight * 0.8)
                          : window.scrollBy(0, 600);
        await U.humanDelay(700, 1300);

        // 已知总数且已抓满 → 提前结束
        const nowTotal = parseTotalFromText();
        if (nowTotal && byKey.size >= nowTotal) {
          collect();
          break;
        }
        if (byKey.size === before) {
          // 滚动无新增：先试翻页（分页表格布局），再考虑到底
          const nextBtn = findNextPageButton();
          if (nextBtn && !pagedToEnd) {
            nextBtn.click();
            await U.humanDelay(1200, 2000);
            collect();
            if (onProgress) onProgress({ phase: 'fetch', done: byKey.size, total: nowTotal });
            // 翻页后仍无新增 → 已是最后一页
            if (byKey.size === before) { pagedToEnd = true; }
            continue;
          }
          idleRounds++;
          if (idleRounds >= 5) break; // 连续 5 轮无新增 → 到底了
        } else {
          idleRounds = 0;
        }
      }

      // 回到列表顶部，方便后续取关定位
      try { findScrollContainer().scrollTo ? findScrollContainer().scrollTo(0, 0) : window.scrollTo(0, 0); } catch (_) {}
      try { history.pushState({}, '', originHref); } catch (_) {}

      const accounts = [...byKey.values()].filter(a => (a.raw && a.raw.stillFollowed) !== false);
      if (!accounts.length) {
        throw new Error('抓取到 0 个关注。若页面显示为空，请先手动打开一次「关注管理」页再重试。');
      }
      return accounts;
    },

    /** 在表格里定位某账号的行（uid 优先，昵称兜底） */
    async findRow(account, { fresh = false } = {}) {
      if (fresh) {
        await this.ensureManagementPage();
      }
      const wantsUid = account.uid && !account.uid.startsWith('name:');
      const name = (account.name || '').trim();

      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        for (const row of collectRows()) {
          const acc = parseRow(row);
          // 昵称优先匹配（接口抓到的 uid 是加密串，页面行内通常没有链接可对）
          if (name && acc.name === name) return row;
          if (wantsUid && acc.uid === account.uid) return row;
          // uid 链接兜底
          if (wantsUid) {
            const a = row.querySelector(`a[href*="/user/${account.uid}"]`)
              || row.querySelector(`a[href$="${account.uid}"]`);
            if (a) return row;
          }
        }
        await U.sleep(500);
      }
      return null;
    },

    /** 取关一个账号：找行 → 点「取消关注」→ 确认弹窗 → 校验行消失 */
    async unfollow(account, { onLog, signal } = {}) {
      // 确保在管理页
      if (!location.pathname.startsWith('/creator-micro/data/following')) {
        await this.ensureManagementPage();
      }

      let row = await this.findRow(account);
      if (!row) {
        // 列表可能已变化，刷新一次再找
        row = await this.findRow(account, { fresh: true });
      }
      if (!row) {
        return { ok: true, message: '列表中未找到该行（可能已取关），跳过' };
      }

      // 行内点「取消关注」
      let btn = null;
      for (const el of row.querySelectorAll('button, [role="button"], a, span, div')) {
        const t = visibleText(el);
        if (t === '取消关注' || t === '已关注') { btn = el; if (t === '取消关注') break; }
      }
      if (!btn) return { ok: false, message: '行内未找到「取消关注」按钮' };

      btn.click();
      await U.humanDelay(700, 1200);
      if (signal && signal.aborted) throw new Error('用户中止');

      // 确认弹窗
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const cands = document.querySelectorAll(
          '[class*="dialog"] button, [class*="modal"] button, [class*="Dialog"] button, [class*="Modal"] button, [class*="confirm"] button'
        );
        let hit = null;
        for (const b of cands) {
          const t = visibleText(b);
          if (t === '确认' || t === '确定' || t === '取消关注') { hit = b; break; }
        }
        if (hit) {
          hit.click();
          await U.humanDelay(600, 1000);
          break;
        }
        await U.sleep(250);
      }

      // 校验：该 uid 的行从 DOM 消失（列表会自动刷新）
      const wantsUid = account.uid && !account.uid.startsWith('name:');
      const vDeadline = Date.now() + 8000;
      while (Date.now() < vDeadline) {
        if (signal && signal.aborted) throw new Error('用户中止');
        const still = await this.findRow(account, { fresh: false });
        if (!still) {
          if (onLog) onLog(`已取关 ${account.name}`);
          return { ok: true, message: 'ok' };
        }
        await U.sleep(600);
      }
      return { ok: false, message: '点击后行未消失，可能失败或被风控' };
    },
  };

  window.AIUnfollow.registerPlatform('douyin', adapter);
})();
