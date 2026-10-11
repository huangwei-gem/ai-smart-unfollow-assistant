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

  function buildAiPayload(chunk) {
return chunk.map(a => {
const o = { uid: a.uid, name: a.name, sign: (a.sign || '').slice(0, 200) };
const raw = a.raw || {};
// 注：抖音 each_follow 实测恒为 true，无信息量，不传 mutual
if (raw.official) o.official = true;
if (raw.vip) o.vip = true;
return o;
});
}

function selectedCount() {
return S.accounts.filter(a => a.checked).length;
}

// ============================================================
// AI 结果缓存：chrome.storage.local，按 平台+uid 缓存；昵称/签名变更自动失效。
// key: aiuf_cache_<platform>_<kind>，kind: cls 主分类 | dom 领域 | sel_<mode> 预设筛选 | q_<hash> 自定义筛选
// 值: { [uid]: { c: 结果, r: 0/1（筛选命中）, h: 资料哈希, t: 时间戳 } }
// 手动改分类也会写回缓存，用户的修正会被记住。
// ============================================================
function cacheKey(kind) { return 'aiuf_cache_' + ((S.platform && S.platform.name) || 'x') + '_' + kind; }
function acctHash(a) { return (a.name || '') + '|' + (a.sign || ''); }
function strHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
async function loadCache(kind) {
try { const k = cacheKey(kind); const d = await chrome.storage.local.get(k); return d[k] || {}; }
catch (_) { return {}; }
}
function saveCache(kind, obj) {
try { chrome.storage.local.set({ [cacheKey(kind)]: obj }).catch(() => {}); } catch (_) {}
}
function updateCacheEntry(kind, uid, entry) {
loadCache(kind).then((c) => { c[uid] = entry; saveCache(kind, c); });
}

  // ============================================================
  // AI 分类
  // ============================================================
  const PROMPT_TMPL = `你是一个社交媒体关注列表分析助手。下面是用户关注的部分账号（JSON 数组）。
字段说明：name 昵称；sign 完整简介签名；official=true 表示官方认证号；vip=true 表示大会员（B站，通常为活跃用户）。

判断时请综合参考以下维度（参考蝉妈妈/飞瓜数据等达人分析平台的评估体系）：
【价值信号】内容垂直单一领域；昵称/签名体现真实创作意图（记录/教学/分享）；认证号、大会员通常更活跃。
【营销号/引流信号】签名或昵称藏联系方式（VX/微/谐音字/emoji 变体、「福利群」「看更多」「懂的来」）；带货/广告/招商/课程推销；虚假权威人设（大师/专家/导师）；卖惨博流量。
【擦边信号】性暗示挑逗文字、身材诱惑、软色情诱导话术，表面挂穿搭/舞蹈/摄影实则靠性张力吸粉。
【僵尸号信号】签名为空且昵称无意义、疑似一次性活动号/节日号（关注理由已消失）、纯搬运无原创。
【熟人信号】昵称像真实姓名或日常网名。

请把每个账号归入以下类别之一：
- 常看博主：内容垂直、质量高，用户大概率仍想看的创作者
- 可能认识：疑似现实朋友同事同学（看昵称特征）
- 僵尸号：长期不活跃、无有效内容特征，或简介为空且昵称无意义
- 营销号：广告、带货、推广、引流、微商、虚假人设性质明显
- 不感兴趣：低价值、标题党、擦边低俗、或没有充分理由继续关注的账号

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

  // ============================================================
  // AI 并发调度器：N 路（默认 3）并行消费同一批次队列，每批独立走 SW
  // 故障转移链；worker 错峰启动 + 批间隔抖动，降低齐射触发限流的概率。
  // opts: { items, batchSize, workers, shouldStop, setProgress, makeMessages, onResult }
  //   shouldStop()  → true 时 worker 不再取新批（在途请求结果仍会回调）
  //   onResult(chunk, resp, batchNo) → 成功/失败都回调，解析与缓存由调用方处理
  // ============================================================
  async function runAiConcurrent(opts) {
    const { items, batchSize, workers, shouldStop, setProgress, makeMessages, onResult } = opts;
    const total = items.length;
    const totalBatches = Math.ceil(total / batchSize);
    let cursor = 0;
    let done = 0;
    let batchNo = 0;

    async function worker(wid) {
      if (wid > 0) await U.humanDelay(700 + wid * 600, 1100 + wid * 600); // 错峰启动
      while (!shouldStop()) {
        if (cursor >= total) return;
        const i = cursor; cursor += batchSize;
        const chunk = items.slice(i, Math.min(i + batchSize, total));
        const myNo = ++batchNo;
        setProgress(done, total);
        let resp;
        try {
          resp = await chrome.runtime.sendMessage({ type: 'AI_CHAT', payload: { messages: makeMessages(chunk) } });
        } catch (e) {
          resp = { ok: false, error: String(e && e.message || e) };
        }
        onResult(chunk, resp, myNo);
        done += chunk.length;
        setProgress(done, total);
        if (cursor < total) await U.humanDelay(300, 900);
      }
    }

    const n = Math.max(1, Math.min(workers | 0 || 3, 6, totalBatches || 1));
    log(`并发调度：${n} 路并行，共 ${totalBatches} 批（每批 ${batchSize} 人）`);
    await Promise.all(Array.from({ length: n }, (_, w) => worker(w)));
    return { done, totalBatches };
  }

  async function runAiClassify() {
    const adapter = S.platform && S.platform.adapter;
    if (!adapter) return;
    const targets = S.accounts; // 全量分类
    if (!targets.length) return;

    S.aiRunning = true;
    S.error = null;

    // 缓存命中：资料未变（昵称+签名哈希一致）的直接复用上次结果，只把新的/资料变更过的送给 AI
    const cache = await loadCache('cls');
    const needAi = [];
    let cacheHit = 0;
    for (const a of targets) {
      const c = cache[a.uid];
      if (c && c.h === acctHash(a) && CATEGORIES.includes(c.c)) { a.category = c.c; cacheHit++; }
      else needAi.push(a);
    }
    log(cacheHit ? `缓存命中 ${cacheHit} 人，本次只需新识别 ${needAi.length} 人` : '无缓存，本次全量识别 ' + needAi.length + ' 人');
    if (!needAi.length) {
      log('全部账号均有有效缓存，已秒级完成，无需调用 AI');
      S.aiRunning = false;
      S.aiProgress = null;
      render();
      return;
    }

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
    const totalCount = needAi.length;
    const workers = U.clamp(parseInt(settings && settings.parallel, 10) || 3, 1, 6);

    await runAiConcurrent({
      items: needAi,
      batchSize,
      workers,
      shouldStop: () => S.aiRunning,
      setProgress: (d, t) => { S.aiProgress = { done: d, total: t }; render(); },
      makeMessages: (chunk) => [
        { role: 'system', content: '你是严谨的分类器，只输出要求的 JSON。' },
        { role: 'user', content: PROMPT_TMPL + JSON.stringify(buildAiPayload(chunk)) },
      ],
      onResult: (chunk, resp, no) => {
        if (!resp || !resp.ok) {
          const err = (resp && resp.error) || '未知错误';
          failBatches++;
          if (!firstErr) firstErr = err;
          S.lastAiErr = err;
          log(`AI 请求失败（第 ${no} 批）：${err}`);
          if (err && /未配置/.test(err)) {
            S.error = '未配置 AI 接口：请点击浏览器工具栏的插件图标，填写接口地址与 API Key 后重试。也可以手动编辑分类后直接执行。';
            S.aiRunning = false; // 让其它 worker 也停下
          }
          return;
        }
        try {
          const arr = parseAiJson(resp.content);
          const byUid = new Map();
          for (const item of arr) {
            if (item && item.uid != null) byUid.set(String(item.uid), item.category);
          }
          let hit = 0;
          for (const a of chunk) {
            const c = byUid.get(String(a.uid));
            if (c && CATEGORIES.includes(c)) {
              a.category = c; hit++;
              cache[a.uid] = { c, h: acctHash(a), t: Date.now() };
            }
            else if (c) { a.category = UNSORTED; }
          }
          saveCache('cls', cache);
          log(`AI 分类完成一批：${chunk.length} 人中成功匹配 ${hit} 人${resp.via ? `（接口：${resp.via}）` : ''}`);
        } catch (e) {
          log(`AI 返回解析失败，本批保留「未分类」：${e.message}`);
        }
      },
    });

    // 全部批次失败时，在面板上直接展示错误（不再只藏在折叠日志里）
    if (failBatches > 0 && done > 0 && failBatches * batchSize >= totalCount) {
      S.error = `AI 分类请求失败：${firstErr}。可点上方「一键修复接口权限」后重试，或手动编辑分类。`;
    }

    S.aiRunning = false;
    S.aiProgress = null;
    render();
  }

  // ============================================================
  // AI 筛选：预设模式（默认玩法）+ 自定义描述，共用「勾选 uid」管线
  // ============================================================
  const FILTER_PROMPT = `你是一个社交媒体账号筛选助手。下面是用户的关注账号列表（JSON 数组）。
字段说明：name 昵称；sign 完整简介签名；official=true 官方认证；vip=true 大会员（B站）。
用户会给出一段筛选描述，请综合昵称、签名、账号特征从列表中选出符合描述的账号。

输出要求：严格输出 JSON 数组，不要输出任何其它文字或 markdown 代码块标记。
格式：["uid1","uid2"]
只输出符合描述的账号的 uid；如果没有符合的，输出 []。

筛选描述：
`;

  const PRESET_MODES = {
borderline: {
label: '擦边检测',
prompt: `你是一个社交媒体账号审查助手。下面是用户的关注账号列表（JSON 数组，字段见说明）。
请选出具有「擦边/软色情/低俗引流」特征的账号，判断依据（参考抖音恶意营销号治理规范）：
- 昵称或签名含性暗示、挑逗、诱惑性文字或谐音擦边词
- 强调身材/颜值诱惑、大尺度内容暗示（如「私密」「福利」「源」「完整版」等诱导话术）
- 昵称暧昧+大量装饰符号（🌸💞♦️类）、「单身/离异/交友/处对象」标签
- 表面挂「穿搭/舞蹈/摄影/情感」标签，实则明显靠性张力引流吸粉
- 签名引导到站外私域（微信变体、二维码暗语）
注意：正常舞蹈/健身/穿搭创作者、官方媒体号不算擦边，不要误伤。

输出要求：严格输出 JSON 数组，不要输出任何其它文字或 markdown 代码块标记。
格式：["uid1","uid2"]
只输出擦边账号的 uid；没有则输出 []。

账号列表：
`,
    },
watch: {
label: '常看程度',
prompt: `你是一个社交媒体关注列表分析助手。下面是用户关注的部分账号（JSON 数组，字段见说明）。
请选出「用户大概率已经不常看/无感」的账号，判断依据：
- 一次性活动号、节日号、事件号（如某个活动/婚礼/比赛专门开的号，关注理由已消失）
- 内容小众且与日常兴趣明显不符、无持续关注价值
- 签名有停更说明、久未更新迹象、或纯转发搬运无原创
- 疑似批量营销号/AI 批量生成内容、三无小号
- 签名与昵称完全看不出内容方向、无法产生持续价值
注意：昵称像真实姓名的疑似好友、明显优质垂直创作者（含认证号/大会员）、正常生活记录号不要选。

输出要求：严格输出 JSON 数组，不要输出任何其它文字或 markdown 代码块标记。
格式：["uid1","uid2"]
只输出「不常看/无感」账号的 uid；没有则输出 []。

账号列表：
`,
    },
  };

  const DOMAIN_PROMPT = `你是一个社交媒体账号分析助手。下面是用户的关注账号列表（JSON 数组，字段见说明）。
请给每个账号打一个内容领域标签，参考以下类目体系（参考飞瓜数据/新抖的达人分类）：
美食、美妆、穿搭时尚、颜值、剧情段子、搞笑、音乐、舞蹈、游戏、动漫、影视综艺、明星娱乐、三农、汽车、数码科技、知识科普、财经、房产、母婴育儿、教育培训、体育、健身、旅游户外、宠物、情感、职场、家居生活、艺术绘画、Vlog日常、带货直播、新闻资讯、公益正能量。
要求：领域名不超过 6 个字，优先使用上述参考标签（B站 UP主可按 B站分区归类：如鬼畜归搞笑、番剧归动漫）；无法判断时用「其他」。

输出要求：严格输出 JSON 数组，不要输出任何其它文字或 markdown 代码块标记。
格式：[{"uid":"账号uid","category":"领域名"}]
必须覆盖输入列表中的每一个 uid。

账号列表：
`;

  /** 通用「勾选 uid」筛选管线：预设模式与自定义共用；cacheKind 传入时启用缓存（不重复识别） */
  async function runAiSelect(promptText, noteLabel, cacheKind) {
    const targets = S.accounts;
    if (!targets.length) return;

    S.filtering = true;
    S.error = null;
    S.filterNote = null;
    S.filterLabel = noteLabel;

    // 缓存命中：资料未变的直接复用上次判定结果，只送新的/变更过的给 AI
    const cache = cacheKind ? await loadCache(cacheKind) : null;
    const needAi = [];
    let cacheHit = 0;
    const matched = new Set();
    if (cache) {
      for (const a of targets) {
        const c = cache[a.uid];
        if (c && c.h === acctHash(a)) {
          if (c.r) matched.add(String(a.uid));
          cacheHit++;
        } else needAi.push(a);
      }
      log(cacheHit ? `缓存命中 ${cacheHit} 人，本次只需新识别 ${needAi.length} 人` : '无缓存，本次全量识别 ' + needAi.length + ' 人');
    }

    let settings = null;
    try { settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }); } catch (_) {}
    const batchSize = U.clamp(parseInt(settings && settings.batchSize, 10) || 40, 5, 100);

    let done = 0;
    let failBatches = 0;
    let firstErr = '';
    const totalCount = needAi.length;
    const workers = U.clamp(parseInt(settings && settings.parallel, 10) || 3, 1, 6);

    await runAiConcurrent({
      items: needAi,
      batchSize,
      workers,
      shouldStop: () => S.filtering,
      setProgress: (d, t) => { S.filterProgress = { done: d, total: t }; render(); },
      makeMessages: (chunk) => [
        { role: 'system', content: '你是严谨的筛选器，只输出要求的 JSON。' },
        { role: 'user', content: promptText + JSON.stringify(buildAiPayload(chunk)) },
      ],
      onResult: (chunk, resp, no) => {
        if (!resp || !resp.ok) {
          failBatches++;
          if (!firstErr) firstErr = (resp && resp.error) || '未知错误';
          log(`AI 筛选请求失败（第 ${no} 批）：${(resp && resp.error) || ''}`);
          return;
        }
        try {
          const arr = parseAiJson(resp.content);
          const uidSet = new Set();
          for (const uid of arr) { if (uid) { uidSet.add(String(uid)); matched.add(String(uid)); } }
          if (cache) {
            for (const a of chunk) {
              cache[a.uid] = { r: uidSet.has(String(a.uid)) ? 1 : 0, h: acctHash(a), t: Date.now() };
            }
            saveCache(cacheKind, cache);
          }
        } catch (e) {
          log(`AI 筛选返回解析失败，本批跳过：${e.message}`);
        }
      },
    });

    S.filtering = false;
    S.filterProgress = null;
    S.filterLabel = '';

    if (failBatches > 0 && failBatches * batchSize >= needAi.length) {
      S.error = `AI 筛选请求失败：${firstErr}。请检查接口配置后重试。`;
    } else {
      // 只勾选 AI 命中的账号（在已抓到的列表里的）
      let n = 0;
      for (const a of S.accounts) {
        a.checked = matched.has(String(a.uid));
        if (a.checked) n++;
      }
      const cacheInfo = cache ? `（缓存命中 ${cacheHit}，新识别 ${needAi.length}）` : '';
      S.filterNote = `【${noteLabel}】已自动勾选 ${n} 个账号${cacheInfo}，确认无误后点下方红色按钮执行取关。`;
      log(`AI 筛选完成：${noteLabel} → 勾选 ${n} 人${cacheInfo}`);
    }
    render();
  }

  async function runAiPreset(mode) {
    const m = PRESET_MODES[mode];
    if (!m) return;
    await runAiSelect(m.prompt, m.label, 'sel_' + mode);
  }

  async function runAiCustom() {
    const q = (S.userQuery || '').trim();
    if (!q) {
      S.error = '请先输入筛选描述，例如：很久不更新 / 广告带货 / 昵称像机器人的';
      render();
      return;
    }
    await runAiSelect(FILTER_PROMPT + q + '\n\n账号列表：\n', `自定义「${q}」`, 'q_' + strHash(q));
  }

  /** 领域分组：AI 给每个账号打领域标签 → 复用分组视图展示，可按组勾选（结果同样走缓存，不重复识别） */
  async function runAiDomain() {
    const targets = S.accounts;
    if (!targets.length) return;

    S.filtering = true;
    S.error = null;
    S.filterNote = null;
    S.filterLabel = '按领域分组';

    const cache = await loadCache('dom');
    const needAi = [];
    let cacheHit = 0;
    for (const a of targets) {
      const c = cache[a.uid];
      if (c && c.h === acctHash(a) && c.c) { a.category = c.c; cacheHit++; }
      else needAi.push(a);
    }
    log(cacheHit ? `缓存命中 ${cacheHit} 人，本次只需新识别 ${needAi.length} 人` : '无缓存，本次全量识别 ' + needAi.length + ' 人');

    let settings = null;
    try { settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }); } catch (_) {}
    const batchSize = U.clamp(parseInt(settings && settings.batchSize, 10) || 40, 5, 100);

    let done = 0;
    let failBatches = 0;
    let firstErr = '';
    let hit = 0;
    const totalCount = needAi.length;
    const workers = U.clamp(parseInt(settings && settings.parallel, 10) || 3, 1, 6);

    if (needAi.length) {
    await runAiConcurrent({
      items: needAi,
      batchSize,
      workers,
      shouldStop: () => S.filtering,
      setProgress: (d, t) => { S.filterProgress = { done: d, total: t }; render(); },
      makeMessages: (chunk) => [
        { role: 'system', content: '你是严谨的分类器，只输出要求的 JSON。' },
        { role: 'user', content: DOMAIN_PROMPT + JSON.stringify(buildAiPayload(chunk)) },
      ],
      onResult: (chunk, resp, no) => {
        if (!resp || !resp.ok) {
          failBatches++;
          if (!firstErr) firstErr = (resp && resp.error) || '未知错误';
          log(`领域分组请求失败（第 ${no} 批）：${(resp && resp.error) || ''}`);
          return;
        }
        try {
          const arr = parseAiJson(resp.content);
          const byUid = new Map();
          for (const item of arr) {
            if (item && item.uid != null) byUid.set(String(item.uid), String(item.category || '').slice(0, 8));
          }
          for (const a of chunk) {
            const c = byUid.get(String(a.uid));
            if (c) {
              a.category = c;
              hit++;
              cache[a.uid] = { c, h: acctHash(a), t: Date.now() };
            }
          }
          saveCache('dom', cache);
        } catch (e) {
          log(`领域分组返回解析失败，本批跳过：${e.message}`);
        }
      },
    });
    } // end if needAi.length

    S.filtering = false;
    S.filterProgress = null;
    S.filterLabel = '';

    if (failBatches > 0 && failBatches * batchSize >= needAi.length) {
      S.error = `领域分组请求失败：${firstErr}。请检查接口配置后重试。`;
    } else {
      S.filterNote = `【按领域分组】已完成（缓存命中 ${cacheHit}，新识别 ${needAi.length}），可按组勾选后取关。`;
      log(`领域分组完成：命中 ${cacheHit} + 新识别 ${needAi.length} 人`);
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
          <div class="aiuf-head"><b>🧹 AI 智能取关助手 <span class="aiuf-ver">v1.7</span></b><span class="aiuf-close" id="aiuf-close">✕</span></div>
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
${S.error ? `<div class="aiuf-err">${esc(S.error)}</div>
${/网络请求失败|Failed to fetch|CORS|所有接口均失败|权限/.test(S.error || '') ? '<button class="aiuf-btn" id="aiuf-fixperm" style="margin-top:6px">⚠ 一键修复接口权限</button>' : ''}` : ''}
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
              <div class="nm">${esc(a.name)}${(a.raw && a.raw.official) ? ' <span class="aiuf-tag v">认证</span>' : ''}${(a.raw && a.raw.vip) ? ' <span class="aiuf-tag p">大会员</span>' : ''}</div>
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

    // 面板内一键修复接口权限（内容脚本里发起，用户点击即手势，无需打开弹窗）
    const fixperm = $('aiuf-fixperm');
    if (fixperm) fixperm.onclick = async () => {
      try {
        const origins = chrome.runtime.getManifest().host_permissions || [];
        const granted = await chrome.permissions.request({ origins });
        if (granted) {
          S.error = '';
          S.lastAiErr = '';
          log('接口权限已修复，请重新点击 AI 分类。');
        } else {
          S.error = '权限修复未完成：请在弹窗中勾选全部网站访问权限。';
        }
      } catch (e) {
        S.error = '权限修复失败：' + (e && e.message || e);
      }
      render();
    };

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

// 单个改分类（写回缓存，用户的修正会被记住，下次不再重复识别）
rootEl.querySelectorAll('select[data-role="cat"]').forEach((el) => {
el.onchange = () => {
const acc = S.accounts.find(x => x.uid === el.dataset.uid);
if (acc) {
acc.category = el.value;
const entry = { h: acctHash(acc), t: Date.now() };
if (CATEGORIES.includes(el.value)) { entry.c = el.value; updateCacheEntry('cls', acc.uid, entry); }
else { entry.c = el.value; updateCacheEntry('dom', acc.uid, entry); }
}
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
