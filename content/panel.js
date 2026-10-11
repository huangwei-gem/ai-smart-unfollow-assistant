// ============================================================
// 悬浮面板：content/panel.js
// 状态机：idle → fetching → reviewing → confirming → executing → done
// 依赖：platform-adapter.js 提供的 window.AIUnfollow；样式见 content/panel.css（manifest 注入）。
// ============================================================

(function () {
  'use strict';
  const U = window.AIUnfollow.utils;

  // ---------- 常量 ----------
  const CATEGORIES = ['常看博主', '可能认识', '僵尸号', '营销号', '不感兴趣'];
  const DEFAULT_CHECKED = new Set(['僵尸号', '营销号', '不感兴趣']); // AI 建议默认勾选
  const UNSORTED = '未分类';

  const PHASE = {
    IDLE: 'idle',
    FETCHING: 'fetching',
    REVIEWING: 'reviewing',
    CONFIRMING: 'confirming',
    EXECUTING: 'executing',
    DONE: 'done',
  };

  // ---------- 状态 ----------
  const S = {
    phase: PHASE.IDLE,
    platform: null,          // { name, adapter }
    accounts: [],            // [{uid,name,sign,avatar,category,checked,reason?}]
    fetchProgress: null,     // {done,total,phase}
    aiProgress: null,        // {done,total}
    execProgress: null,      // {done,total,ok,fail}
    logs: [],
    error: null,
    fetchAbort: null,        // AbortController
    execAbort: null,
    aiRunning: false,
    nameFilter: '',
    logOpen: false,          // 「执行详情」折叠框是否展开
    userQuery: '',           // 自定义筛选描述
    filtering: false,        // AI 筛选进行中（预设/自定义共用）
    filterLabel: '',         // 当前筛选模式名
    filterProgress: null,    // {done,total}
    filterNote: null,        // 筛选结果提示
  };

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function log(msg) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    S.logs.push(`[${t}] ${msg}`);
    if (S.logs.length > 400) S.logs.shift();
  }

  // 日志收进可折叠「详情」，不直接暴露给用户；展开状态跨重渲染保持
  function renderLog(max) {
    const lines = S.logs.slice(-max);
    if (!lines.length) return '';
    return `
      <details class="aiuf-logwrap" id="aiuf-logwrap" ${S.logOpen ? 'open' : ''}>
        <summary>执行详情（${S.logs.length} 条）</summary>
        <div class="aiuf-log">${esc(lines.join('\n'))}</div>
      </details>`;
  }

  function groupAccounts() {
    const map = new Map();
    for (const c of [...CATEGORIES, UNSORTED]) map.set(c, []);
    for (const a of S.accounts) {
      const c = a.category || UNSORTED;
      if (!map.has(c)) map.set(c, []);
      map.get(c).push(a);
    }
    return map;
  }

  function selectedCount() {
    return S.accounts.filter(a => a.checked).length;
  }

  // ============================================================
  // AI 分类
  // ============================================================
  const PROMPT_TMPL = `你是一个社交媒体关注列表分析助手。下面是用户关注的部分账号（JSON 数组，字段：uid、name 昵称、sign 简介签名）。
请把每个账号归入以下类别之一：
- 常看博主：内容质量高、用户大概率仍想看的创作者（如明显的知识/技术/生活记录类）
- 可能认识：昵称像真实姓名、疑似现实朋友同事同学
- 僵尸号：长期不活跃、无有效内容特征，或简介为空且昵称无意义
- 营销号：广告、带货、推广、引流、微商性质明显
- 不感兴趣：低价值、标题党、或没有充分理由继续关注的账号

输出要求：严格输出 JSON 数组，不要输出任何其它文字或 markdown 代码块标记。
格式：[{"uid":"账号uid","category":"类别名"}]
必须覆盖输入列表中的每一个 uid，类别名必须使用上面给出的五个类别名之一。

账号列表：
`;

  function parseAiJson(content) {
    let text = String(content || '').trim();
    // 去掉可能的 ```json 包裹
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) throw new Error('AI 返回中找不到 JSON 数组');
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) throw new Error('AI 返回不是数组');
    return arr;
  }

  async function runAiClassify() {
    const adapter = S.platform && S.platform.adapter;
    if (!adapter) return;
    const targets = S.accounts; // 全量分类
    if (!targets.length) return;

    S.aiRunning = true;
    S.error = null;

    // 读取设置
    let settings = null;
    try {
      settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    } catch (e) {
      settings = null;
    }
    const batchSize = U.clamp(parseInt(settings && settings.batchSize, 10) || 40, 5, 100);

    let done = 0;
    let failBatches = 0;
    let firstErr = '';
    for (let i = 0; i < targets.length; i += batchSize) {
      if (!S.aiRunning) { log('AI 分类已手动停止'); break; }
      const chunk = targets.slice(i, i + batchSize);
      S.aiProgress = { done, total: targets.length };
      render();

      const payload = chunk.map(a => ({ uid: a.uid, name: a.name, sign: (a.sign || '').slice(0, 60) }));
      const messages = [
        { role: 'system', content: '你是严谨的分类器，只输出要求的 JSON。' },
        { role: 'user', content: PROMPT_TMPL + JSON.stringify(payload) },
      ];

      let resp;
      try {
        resp = await chrome.runtime.sendMessage({ type: 'AI_CHAT', payload: { messages } });
      } catch (e) {
        resp = { ok: false, error: String(e && e.message || e) };
      }

      if (!resp || !resp.ok) {
        const err = (resp && resp.error) || '未知错误';
        failBatches++;
        if (!firstErr) firstErr = err;
        log(`AI 请求失败（第 ${Math.floor(i / batchSize) + 1} 批）：${err}`);
        if (err && /未配置/.test(err)) {
          S.error = '未配置 AI 接口：请点击浏览器工具栏的插件图标，填写接口地址与 API Key 后重试。也可以手动编辑分类后直接执行。';
          break;
        }
        // 单批失败不放弃整体，继续下一批
      } else {
        try {
          const arr = parseAiJson(resp.content);
          const byUid = new Map();
          for (const item of arr) {
            if (item && item.uid != null) byUid.set(String(item.uid), item.category);
          }
          let hit = 0;
          for (const a of chunk) {
            const c = byUid.get(String(a.uid));
            if (c && CATEGORIES.includes(c)) { a.category = c; hit++; }
            else if (c) { a.category = UNSORTED; }
          }
          log(`AI 分类完成一批：${chunk.length} 人中成功匹配 ${hit} 人`);
        } catch (e) {
          log(`AI 返回解析失败，本批保留「未分类」：${e.message}`);
        }
      }

      done += chunk.length;
      S.aiProgress = { done, total: targets.length };
      render();
      if (i + batchSize < targets.length) await U.humanDelay(400, 900);
    }

    // 全部批次失败时，在面板上直接展示错误（不再只藏在折叠日志里）
    if (failBatches > 0 && done > 0 && failBatches * batchSize >= targets.length) {
      S.error = `AI 分类请求失败：${firstErr}。请检查接口配置后重试，或手动编辑分类。`;
    }

    S.aiRunning = false;
    S.aiProgress = null;
    render();
  }

  // ============================================================
  // AI 筛选：预设模式（默认玩法）+ 自定义描述，共用「勾选 uid」管线
  // ============================================================
  const FILTER_PROMPT = `你是一个社交媒体账号筛选助手。下面是用户的关注账号列表（JSON 数组，字段：uid、name 昵称、sign 简介签名）。
用户会给出一段筛选描述，请从列表中选出符合描述的账号。

输出要求：严格输出 JSON 数组，不要输出任何其它文字或 markdown 代码块标记。
格式：["uid1","uid2"]
只输出符合描述的账号的 uid；如果没有符合的，输出 []。

筛选描述：
`;

  const PRESET_MODES = {
    borderline: {
      label: '擦边检测',
      prompt: `你是一个社交媒体账号审查助手。下面是用户的关注账号列表（JSON 数组，字段：uid、name 昵称、sign 简介签名）。
请选出具有「擦边/软色情」特征的账号，判断依据包括：
- 昵称或简介含性暗示、挑逗、诱惑性文字或谐音擦边词
- 强调身材/颜值诱惑、大尺度内容暗示（如「私密」「福利」「源」等诱导话术）
- 打美女/帅哥引流招牌、内容定位明显靠性张力吸粉

输出要求：严格输出 JSON 数组，不要输出任何其它文字或 markdown 代码块标记。
格式：["uid1","uid2"]
只输出擦边账号的 uid；没有则输出 []。

账号列表：
`,
    },
    watch: {
      label: '常看程度',
      prompt: `你是一个社交媒体关注列表分析助手。下面是用户关注的部分账号（JSON 数组，字段：uid、name 昵称、sign 简介签名）。
请选出「用户大概率已经不常看/无感」的账号，判断依据包括：
- 一次性活动号、节日号、事件号（关注理由已消失）
- 内容小众且与日常兴趣明显不符、无持续关注价值
- 简介有停更说明、僵尸迹象、或纯转发搬运无原创
注意：真实姓名的疑似朋友、明显优质创作者不要选。

输出要求：严格输出 JSON 数组，不要输出任何其它文字或 markdown 代码块标记。
格式：["uid1","uid2"]
只输出「不常看/无感」账号的 uid；没有则输出 []。

账号列表：
`,
    },
  };

  const DOMAIN_PROMPT = `你是一个社交媒体账号分析助手。下面是用户的关注账号列表（JSON 数组，字段：uid、name 昵称、sign 简介签名）。
请给每个账号打一个内容领域标签，参考标签：美食、科技、影视、健身、游戏、音乐、知识、生活记录、明星娱乐、新闻资讯、宠物、美妆穿搭、带货营销、其他。
要求：领域名不超过 6 个字，优先使用参考标签；无法判断时用「其他」。

输出要求：严格输出 JSON 数组，不要输出任何其它文字或 markdown 代码块标记。
格式：[{"uid":"账号uid","category":"领域名"}]
必须覆盖输入列表中的每一个 uid。

账号列表：
`;

  /** 通用「勾选 uid」筛选管线：预设模式与自定义共用 */
  async function runAiSelect(promptText, noteLabel) {
    const targets = S.accounts;
    if (!targets.length) return;

    S.filtering = true;
    S.error = null;
    S.filterNote = null;
    S.filterLabel = noteLabel;

    let settings = null;
    try { settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }); } catch (_) {}
    const batchSize = U.clamp(parseInt(settings && settings.batchSize, 10) || 40, 5, 100);

    const matched = new Set();
    let done = 0;
    let failBatches = 0;
    let firstErr = '';

    for (let i = 0; i < targets.length; i += batchSize) {
      if (!S.filtering) { log('AI 筛选已手动停止'); break; }
      const chunk = targets.slice(i, i + batchSize);
      S.filterProgress = { done, total: targets.length };
      render();

      const payload = chunk.map(a => ({ uid: a.uid, name: a.name, sign: (a.sign || '').slice(0, 60) }));
      const messages = [
        { role: 'system', content: '你是严谨的筛选器，只输出要求的 JSON。' },
        { role: 'user', content: promptText + JSON.stringify(payload) },
      ];

      let resp;
      try {
        resp = await chrome.runtime.sendMessage({ type: 'AI_CHAT', payload: { messages } });
      } catch (e) {
        resp = { ok: false, error: String(e && e.message || e) };
      }

      if (!resp || !resp.ok) {
        failBatches++;
        if (!firstErr) firstErr = (resp && resp.error) || '未知错误';
        log(`AI 筛选请求失败（第 ${Math.floor(i / batchSize) + 1} 批）：${(resp && resp.error) || ''}`);
      } else {
        try {
          const arr = parseAiJson(resp.content);
          for (const uid of arr) { if (uid) matched.add(String(uid)); }
        } catch (e) {
          log(`AI 筛选返回解析失败，本批跳过：${e.message}`);
        }
      }

      done += chunk.length;
      S.filterProgress = { done, total: targets.length };
      render();
      if (i + batchSize < targets.length) await U.humanDelay(400, 900);
    }

    S.filtering = false;
    S.filterProgress = null;
    S.filterLabel = '';

    if (failBatches > 0 && failBatches * batchSize >= targets.length) {
      S.error = `AI 筛选请求失败：${firstErr}。请检查接口配置后重试。`;
    } else {
      // 只勾选 AI 命中的账号（在已抓到的列表里的）
      let n = 0;
      for (const a of S.accounts) {
        a.checked = matched.has(String(a.uid));
        if (a.checked) n++;
      }
      S.filterNote = `【${noteLabel}】已自动勾选 ${n} 个账号，确认无误后点下方红色按钮执行取关。`;
      log(`AI 筛选完成：${noteLabel} → 勾选 ${n} 人`);
    }
    render();
  }

  async function runAiPreset(mode) {
    const m = PRESET_MODES[mode];
    if (!m) return;
    await runAiSelect(m.prompt, m.label);
  }

  async function runAiCustom() {
    const q = (S.userQuery || '').trim();
    if (!q) {
      S.error = '请先输入筛选描述，例如：很久不更新 / 广告带货 / 昵称像机器人的';
      render();
      return;
    }
    await runAiSelect(FILTER_PROMPT + q + '\n\n账号列表：\n', `自定义「${q}」`);
  }

  /** 领域分组：AI 给每个账号打领域标签 → 复用分组视图展示，可按组勾选 */
  async function runAiDomain() {
    const targets = S.accounts;
    if (!targets.length) return;

    S.filtering = true;
    S.error = null;
    S.filterNote = null;
    S.filterLabel = '按领域分组';

    let settings = null;
    try { settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }); } catch (_) {}
    const batchSize = U.clamp(parseInt(settings && settings.batchSize, 10) || 40, 5, 100);

    let done = 0;
    let failBatches = 0;
    let firstErr = '';
    let hit = 0;

    for (let i = 0; i < targets.length; i += batchSize) {
      if (!S.filtering) { log('领域分组已手动停止'); break; }
      const chunk = targets.slice(i, i + batchSize);
      S.filterProgress = { done, total: targets.length };
      render();

      const payload = chunk.map(a => ({ uid: a.uid, name: a.name, sign: (a.sign || '').slice(0, 60) }));
      const messages = [
        { role: 'system', content: '你是严谨的分类器，只输出要求的 JSON。' },
        { role: 'user', content: DOMAIN_PROMPT + JSON.stringify(payload) },
      ];

      let resp;
      try {
        resp = await chrome.runtime.sendMessage({ type: 'AI_CHAT', payload: { messages } });
      } catch (e) {
        resp = { ok: false, error: String(e && e.message || e) };
      }

      if (!resp || !resp.ok) {
        failBatches++;
        if (!firstErr) firstErr = (resp && resp.error) || '未知错误';
        log(`领域分组请求失败（第 ${Math.floor(i / batchSize) + 1} 批）：${(resp && resp.error) || ''}`);
      } else {
        try {
          const arr = parseAiJson(resp.content);
          for (const item of arr) {
            const acc = S.accounts.find(x => x.uid === item.uid);
            if (acc && item.category) { acc.category = String(item.category).slice(0, 8); hit++; }
          }
        } catch (e) {
          log(`领域分组返回解析失败，本批跳过：${e.message}`);
        }
      }

      done += chunk.length;
      S.filterProgress = { done, total: targets.length };
      render();
      if (i + batchSize < targets.length) await U.humanDelay(400, 900);
    }

    S.filtering = false;
    S.filterProgress = null;
    S.filterLabel = '';

    if (failBatches > 0 && failBatches * batchSize >= targets.length) {
      S.error = `领域分组请求失败：${firstErr}。请检查接口配置后重试。`;
    } else {
      S.filterNote = `【按领域分组】已完成，${hit} 个账号已归入各自领域，可按组勾选后取关。`;
      log(`领域分组完成：${hit} 人`);
    }
    render();
  }

  // ============================================================
  // 抓取
  // ============================================================
  async function startFetch() {
    const adapter = S.platform && S.platform.adapter;
    if (!adapter) return;
    // 抖音主站 → 先跳创作者平台关注管理页
    if (adapter.needsRedirect && adapter.needsRedirect()) {
      const okGo = window.confirm(
        '抖音取关在创作者平台的「关注管理」页完成（需已用抖音 APP 扫码登录创作者平台）。\n' +
        '点「确定」自动跳转，到达后重新点「抓取关注列表」。'
      );
      if (okGo) adapter.goToCreatorPage();
      return;
    }
    S.phase = PHASE.FETCHING;
    S.accounts = [];
    S.error = null;
    S.logs = [];
    S.fetchAbort = new AbortController();
    render();
    const t0 = Date.now();
    try {
      const accounts = await adapter.fetchFollowing({
        onProgress: (p) => { S.fetchProgress = p; render(); },
        signal: S.fetchAbort.signal,
      });
      if (!accounts.length) throw new Error('抓取到 0 个关注，请确认页面状态后重试');
      for (const a of accounts) {
        a.category = UNSORTED;
        a.checked = false;
      }
      S.accounts = accounts;
      log(`抓取完成：共 ${accounts.length} 个关注，耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
      S.phase = PHASE.REVIEWING;
    } catch (e) {
      if (/中止/.test(String(e && e.message))) {
        log('抓取已中止');
        S.phase = PHASE.IDLE;
      } else {
        S.error = '抓取失败：' + (e && e.message || e);
        S.phase = PHASE.IDLE;
      }
    }
    S.fetchProgress = null;
    render();
  }

  // ============================================================
  // 执行取关
  // ============================================================
  async function startExecute() {
    const adapter = S.platform && S.platform.adapter;
    if (!adapter) return;
    const list = S.accounts.filter(a => a.checked);
    if (!list.length) return;

    S.phase = PHASE.EXECUTING;
    S.execProgress = { done: 0, total: list.length, ok: 0, fail: 0 };
    S.error = null;
    S.execAbort = new AbortController();
    const signal = S.execAbort.signal;
    render();

    const isDouyin = S.platform.name === 'douyin';
    let ok = 0, fail = 0;
    for (let i = 0; i < list.length; i++) {
      if (signal.aborted) { log('执行已手动停止'); break; }
      const acc = list[i];
      try {
        const r = await adapter.unfollow(acc, { onLog: (m) => log(m), signal });
        if (r && r.ok) { ok++; acc.checked = false; acc.category = UNSORTED; }
        else { fail++; log(`取关 ${acc.name} 失败：${(r && r.message) || '未知原因'}`); }
      } catch (e) {
        fail++;
        log(`取关 ${acc.name} 异常：${e && e.message || e}`);
        if (/中止/.test(String(e && e.message))) break;
      }
      S.execProgress = { done: i + 1, total: list.length, ok, fail };
      render();
      // 平台间节奏控制：抖音更保守
      const min = isDouyin ? 2200 : 700;
      const max = isDouyin ? 4200 : 1400;
      await U.humanDelay(min, max);
    }

    log(`执行结束：成功 ${ok}，失败 ${fail}`);
    S.execResult = { ok, fail, stopped: signal.aborted };
    S.phase = PHASE.DONE;
    render();
  }

  // ============================================================
  // UI 渲染
  // ============================================================
  let rootEl = null;

  // ---------- 样式 ----------
  // 样式由 manifest 注入的 content/panel.css 提供，这里不再内嵌 CSS。

  function injectCss() {
    // manifest content_scripts.css 已注入；保留空实现以防单独调试。
  }

  function ensureRoot() {
    injectCss();
    if (!rootEl || !document.documentElement.contains(rootEl)) {
      rootEl = document.createElement('div');
      rootEl.id = 'aiuf-root';
      document.documentElement.appendChild(rootEl);
      rootEl.addEventListener('click', (e) => {
        if (e.target === rootEl) togglePanel();
      });
    }
    render();
  }

  function togglePanel() {
    S.collapsed = !S.collapsed;
    render();
  }

  function render() {
    if (!rootEl) return;
    const collapsed = S.collapsed;
    const adapter = S.platform && S.platform.adapter;
    const hint = adapter ? adapter.pageHint() : '当前页面不属于抖音 / B站';

    let inner = '';
    if (collapsed) {
      inner = `<div class="aiuf-ball" id="aiuf-ball" title="AI 取关助手">🧹</div>`;
    } else {
      inner = `
        <div class="aiuf-panel">
          <div class="aiuf-head"><b>🧹 AI 智能取关助手 <span class="aiuf-ver">v1.4</span></b><span class="aiuf-close" id="aiuf-close">✕</span></div>
          <div class="aiuf-body">${renderBody(hint)}</div>
        </div>`;
    }
    rootEl.innerHTML = inner;
    bind();
  }

  function renderBody(hint) {
    const p = S.phase;
    if (!S.platform) {
      return `<div class="aiuf-err">当前页面不是抖音或 B站，请打开对应平台后使用。</div>`;
    }
    if (p === PHASE.IDLE) {
      return `
        <div class="aiuf-hint">${esc(hint || '')}</div>
        ${S.error ? `<div class="aiuf-err">${esc(S.error)}</div>` : ''}
        <button class="aiuf-btn primary" id="aiuf-fetch">① 抓取关注列表</button>
        <div class="aiuf-mini">抓取后自动进入分类确认，全程在你的浏览器本地完成。</div>`;
    }
    if (p === PHASE.FETCHING) {
      const pr = S.fetchProgress || {};
      const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : null;
      const label = pr.phase === 'scan' ? '正在扫描列表…' : '正在抓取主页信息…';
      return `
        <div class="aiuf-mini"><b>${esc(label)}</b> ${pr.done || 0}${pr.total ? ' / ' + pr.total : ''}</div>
        ${pct != null ? `<div class="aiuf-progress"><div style="width:${pct}%"></div></div>` : '<div class="aiuf-progress indeterminate"><div></div></div>'}
        ${renderLog(6)}
        <button class="aiuf-btn ghost" id="aiuf-cancel-fetch">中止</button>
        <div class="aiuf-mini">正在通过接口快速翻页抓取（抖音约每分钟数百人），请保持页面在前台。</div>`;
    }
    if (p === PHASE.REVIEWING || p === PHASE.CONFIRMING) {
      return renderReview();
    }
    if (p === PHASE.EXECUTING) {
      const pr = S.execProgress || { done: 0, total: 0, ok: 0, fail: 0 };
      const pct = pr.total ? Math.round(pr.done / pr.total * 100) : 0;
      return `
        <div class="aiuf-mini"><b>正在取关…</b> ${pr.done} / ${pr.total}（成功 ${pr.ok}，失败 ${pr.fail}）</div>
        <div class="aiuf-progress"><div style="width:${pct}%"></div></div>
        ${renderLog(8)}
        <button class="aiuf-btn ghost" id="aiuf-stop-exec">停止</button>`;
    }
    if (p === PHASE.DONE) {
      const r = S.execResult || {};
      return `
        <div class="aiuf-stat">
          <div>✅ 成功 <b class="ok">${r.ok || 0}</b></div>
          <div>❌ 失败 <b class="fail">${r.fail || 0}</b></div>
        </div>
        ${r.stopped ? '<div class="aiuf-mini">任务被手动停止，可重新勾选继续。</div>' : ''}
        ${renderLog(8)}
        <button class="aiuf-btn primary" id="aiuf-again">再抓一轮 / 重新开始</button>`;
    }
    return '';
  }

  function renderReview() {
    const groups = groupAccounts();
    const total = S.accounts.length;
    const sel = selectedCount();
    const aiBusy = S.aiRunning;

    let html = `
      <div class="aiuf-mini">共抓到 <b>${total}</b> 个关注，已勾选 <b style="color:#ff4d5e">${sel}</b> 个待取关。勾选 = 将取关；去掉勾选 = 保留（白名单）。</div>
      <div class="aiuf-modes">
        <span class="aiuf-modelabel">快捷筛选：</span>
        <button class="aiuf-pill" id="aiuf-mode-borderline" ${S.filtering || aiBusy ? 'disabled' : ''}>🌶️ 擦边检测</button>
        <button class="aiuf-pill" id="aiuf-mode-watch" ${S.filtering || aiBusy ? 'disabled' : ''}>😴 不常看检测</button>
        <button class="aiuf-pill" id="aiuf-mode-domain" ${S.filtering || aiBusy ? 'disabled' : ''}>🧩 按领域分组</button>
      </div>
      <div class="aiuf-qrow">
        <input type="text" id="aiuf-query" placeholder="或自定义描述：很久不更新 / 广告带货 / 昵称是乱码的…" value="${esc(S.userQuery || '')}">
        <button class="aiuf-btn primary" id="aiuf-qrun" ${S.filtering ? 'disabled' : ''}>${S.filtering ? '筛选中…' : 'AI 筛选'}</button>
        ${S.filtering ? '<button class="aiuf-btn ghost" id="aiuf-qstop">停止</button>' : ''}
      </div>
      ${S.filtering && S.filterProgress ? `<div class="aiuf-progress"><div style="width:${Math.max(3, Math.round(S.filterProgress.done / Math.max(1, S.filterProgress.total) * 100))}%"></div></div><div class="aiuf-mini">${esc(S.filterLabel || '筛选中')} ${S.filterProgress.done}/${S.filterProgress.total}…</div>` : ''}
      ${S.filterNote ? `<div class="aiuf-hint">✅ ${esc(S.filterNote)}</div>` : ''}
      <div class="aiuf-toolbar">
        <button class="aiuf-btn primary" id="aiuf-ai-run" ${aiBusy ? 'disabled' : ''}>${aiBusy ? 'AI 分析中…' : '② AI 分类'}</button>
        ${aiBusy && S.aiProgress ? `<span class="aiuf-mini">${S.aiProgress.done}/${S.aiProgress.total}</span>` : ''}
        <button class="aiuf-btn ghost" id="aiuf-ai-stop" ${aiBusy ? '' : 'disabled'}>停止分析</button>
        <input type="text" id="aiuf-filter" placeholder="搜索昵称…" value="${esc(S.nameFilter)}">
      </div>
      ${S.error ? `<div class="aiuf-err">${esc(S.error)}</div>` : ''}
      ${aiBusy && S.aiProgress ? `<div class="aiuf-progress"><div style="width:${S.aiProgress.total ? Math.round(S.aiProgress.done / S.aiProgress.total * 100) : 3}%"></div></div>` : ''}
    `;

    for (const [cat, list] of groups) {
      if (!list.length) continue;
      const checkedInCat = list.filter(a => a.checked).length;
      html += `
        <div class="aiuf-cat-head">
          <span>${esc(cat)}</span><span class="cnt">（${list.length} 人，已选 ${checkedInCat}）</span>
          <span class="ops">
            <a data-act="check" data-cat="${esc(cat)}">全选</a><a data-act="uncheck" data-cat="${esc(cat)}">取消</a>
          </span>
        </div>`;
      const kw = S.nameFilter.trim().toLowerCase();
      for (const a of list) {
        if (kw && !(a.name || '').toLowerCase().includes(kw)) continue;
        const cats = [...CATEGORIES, UNSORTED];
        if (a.category && !cats.includes(a.category)) cats.push(a.category); // 领域分组等动态组名
        const options = cats.map(c =>
          `<option value="${esc(c)}" ${c === (a.category || UNSORTED) ? 'selected' : ''}>${esc(c)}</option>`).join('');
        html += `
          <div class="aiuf-acct">
            <input type="checkbox" data-uid="${esc(a.uid)}" data-role="chk" ${a.checked ? 'checked' : ''}>
            ${a.avatar ? `<img src="${esc(a.avatar)}" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : ''}
            <div class="n">
              <div class="nm">${esc(a.name)}</div>
              ${a.sign ? `<div class="sg">${esc(a.sign)}</div>` : ''}
            </div>
            <select data-uid="${esc(a.uid)}" data-role="cat">${options}</select>
          </div>`;
      }
    }

    html += `
      <div style="margin-top:14px; display:flex; gap:8px;">
        <button class="aiuf-btn ghost" id="aiuf-refetch">重新抓取</button>
        <button class="aiuf-btn danger" id="aiuf-confirm" ${sel ? '' : 'disabled'}>③ 确认并取关（${sel}）</button>
      </div>
      <div class="aiuf-mini">取关不可撤销。点击后将从上到下逐个执行，随时可点「停止」。</div>`;

    return html;
  }

  // ---------- 事件绑定 ----------
  function bind() {
    const $ = (id) => document.getElementById(id);

    const ball = $('aiuf-ball');
    if (ball) ball.onclick = togglePanel;
    const logwrap = $('aiuf-logwrap');
    if (logwrap) logwrap.addEventListener('toggle', () => { S.logOpen = logwrap.open; });
    const close = $('aiuf-close');
    if (close) close.onclick = togglePanel;

    const fetchBtn = $('aiuf-fetch');
    if (fetchBtn) fetchBtn.onclick = () => startFetch();

    const cancelFetch = $('aiuf-cancel-fetch');
    if (cancelFetch) cancelFetch.onclick = () => { if (S.fetchAbort) S.fetchAbort.abort(); };

    const aiRun = $('aiuf-ai-run');
    if (aiRun) aiRun.onclick = () => runAiClassify();
    const aiStop = $('aiuf-ai-stop');
    if (aiStop) aiStop.onclick = () => { S.aiRunning = false; };

    const filter = $('aiuf-filter');
    if (filter) {
      filter.oninput = () => { S.nameFilter = filter.value; render(); const f = $('aiuf-filter'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } };
    }

    // 预设筛选模式
    const modeBtns = [
      ['aiuf-mode-borderline', 'borderline'],
      ['aiuf-mode-watch', 'watch'],
      ['aiuf-mode-domain', null],
    ];
    for (const [btnId, mode] of modeBtns) {
      const b = document.getElementById(btnId);
      if (b) b.onclick = () => { mode ? runAiPreset(mode) : runAiDomain(); };
    }

    // 自定义描述 AI 筛选
    const queryInput = $('aiuf-query');
    if (queryInput) queryInput.oninput = () => { S.userQuery = queryInput.value; }; // 只存值不重绘，保持输入焦点
    const qrun = $('aiuf-qrun');
    if (qrun) qrun.onclick = () => runAiCustom();
    const qstop = $('aiuf-qstop');
    if (qstop) qstop.onclick = () => { S.filtering = false; };

    // 分类组 全选/取消
    rootEl.querySelectorAll('.aiuf-cat-head .ops a').forEach((el) => {
      el.onclick = () => {
        const act = el.dataset.act;
        const cat = el.dataset.cat;
        for (const a of S.accounts) {
          if ((a.category || UNSORTED) === cat) a.checked = (act === 'check');
        }
        render();
      };
    });

    // 单个勾选
    rootEl.querySelectorAll('input[data-role="chk"]').forEach((el) => {
      el.onchange = () => {
        const acc = S.accounts.find(x => x.uid === el.dataset.uid);
        if (acc) acc.checked = el.checked;
        // 只更新统计，不重绘（保持滚动位置）
        const sel = selectedCount();
        const btn = $('aiuf-confirm');
        if (btn) { btn.textContent = `③ 确认并取关（${sel}）`; btn.disabled = sel === 0; }
        const cnt = S.accounts.length;
        const mini = rootEl.querySelector('.aiuf-mini');
        if (mini && cnt) mini.innerHTML = `共抓到 <b>${cnt}</b> 个关注，已勾选 <b style="color:#ff4d5e">${sel}</b> 个待取关。勾选 = 将取关；去掉勾选 = 保留（白名单）。`;
      };
    });

    // 单个改分类
    rootEl.querySelectorAll('select[data-role="cat"]').forEach((el) => {
      el.onchange = () => {
        const acc = S.accounts.find(x => x.uid === el.dataset.uid);
        if (acc) acc.category = el.value;
        render();
      };
    });

    const refetch = $('aiuf-refetch');
    if (refetch) refetch.onclick = () => { S.phase = PHASE.IDLE; S.accounts = []; render(); };

    const confirmBtn = $('aiuf-confirm');
    if (confirmBtn) confirmBtn.onclick = () => startExecute();

    const stopExec = $('aiuf-stop-exec');
    if (stopExec) stopExec.onclick = () => { if (S.execAbort) S.execAbort.abort(); };

    const again = $('aiuf-again');
    if (again) again.onclick = () => { S.phase = PHASE.IDLE; S.accounts = []; S.execResult = null; render(); };
  }

  // ============================================================
  // 启动 & 消息
  // ============================================================
  function detectPlatform() {
    const active = window.AIUnfollow.activeAdapter();
    if (active) S.platform = active;
  }

  function boot() {
    detectPlatform();
    if (!S.platform) return; // 非目标页面不注入
    S.collapsed = true; // 默认只显示悬浮球，不遮挡页面
    ensureRoot();
    const hint = S.platform.adapter.pageHint();
    if (hint) log(hint);
  }

  // 弹窗唤起面板
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'OPEN_PANEL') {
      boot();
      S.collapsed = false;
      render();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
