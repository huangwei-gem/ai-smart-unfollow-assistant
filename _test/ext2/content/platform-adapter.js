// ============================================================
// 平台适配层（跨平台公共模块，注入页面上下文）
// 每个平台脚本向 window.AIUnfollow.registerPlatform(name, adapter) 注册：
//   adapter = {
//     detect(): bool                       — 当前页面是否属于本平台
//     isSupportedPage(): bool              — 当前页面能否开展工作
//     pageHint(): string                   — 引导用户去正确页面的提示
//     fetchFollowing({onProgress, maxPages, signal}): Promise<accounts[]>
//         account = { uid, name, sign, avatar, raw }
//     unfollow(account, {onLog}): Promise<{ok, message}>  — 单个取关
//   }
// ============================================================

(function () {
  'use strict';
  if (window.AIUnfollow && window.AIUnfollow.__injected) return;
  window.AIUnfollow = window.AIUnfollow || {};
  window.AIUnfollow.__injected = true;

  const adapters = {};

  window.AIUnfollow.registerPlatform = function (name, adapter) {
    adapters[name] = adapter;
  };

  window.AIUnfollow.getAdapter = function (name) {
    return adapters[name] || null;
  };

  window.AIUnfollow.activeAdapter = function () {
    for (const name of Object.keys(adapters)) {
      let ok = false;
      try { ok = !!adapters[name].detect(); } catch (_) { ok = false; }
      if (ok) return { name, adapter: adapters[name] };
    }
    return null;
  };

  // ---------- 通用工具 ----------
  window.AIUnfollow.utils = {
    sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

    /** 带抖动的随机延时，模拟人工节奏 */
    async humanDelay(minMs, maxMs) {
      const ms = minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs));
      await this.sleep(ms);
    },

    /** fetch with timeout + no-cors fallback is NOT used; caller must handle errors */
    async fetchJson(url, options = {}, timeoutMs = 15000) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(url, Object.assign({}, options, {
          signal: options.signal ? AbortSignal.any([ctrl.signal, options.signal]) : ctrl.signal,
          credentials: options.credentials || 'include',
        }));
        const text = await resp.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* leave null */ }
        return { ok: resp.ok, status: resp.status, json, text };
      } finally {
        clearTimeout(t);
      }
    },

    clamp(n, min, max) { return Math.min(max, Math.max(min, n)); },
  };
})();
