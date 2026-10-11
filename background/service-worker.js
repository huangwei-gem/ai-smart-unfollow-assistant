// ============================================================
// AI 智能取关助手 — 后台 Service Worker
// 职责：
//   1. 转发 OpenAI 兼容接口的 chat.completions 请求（绕开 CORS）
//   2. 多接口自动故障转移 + 超时 + 限流重试（稳定性保障）
//   3. 保存 / 读取设置（baseUrl / apiKey / model）
// ============================================================

const SETTINGS_KEY = 'ai_unfollow_settings_v1';

const DEFAULT_SETTINGS = {
  // 开箱即用：默认接入已实测可用的商汤 SenseNova（用户可随时在弹窗中更换）
  baseUrl: 'https://token.sensenova.cn/v1',
  apiKey: 'sk-F3WGt9cnsCrduZMyhyTYMEEKYJWE1Mzn',
  model: 'deepseek-v4-flash',
  // 批量分类时每次发送的人数（防止单次请求过大）
  batchSize: 40,
  temperature: 0.2,
};

// 备用接口链：主接口失败（CORS 被撤权 / 限流 / 宕机）时自动逐个切换。
// 全部为 2026-10-10 严格实测通过（真实发送分类消息并校验返回合格 JSON）的模型。
// 注：AMD MiniCPM5-2B 已移除（返回空内容）；opencode 仅 space-bunny-free 可用（其余 free 模型 403 FreeTierError）。
const FALLBACK_ENDPOINTS = [
  { name: 'agnes-2.5-pro-beta', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-P5tZ5ljBOWyNi85fVzabu633Vp88cmP78d4G7279f6k9KNQj', model: 'agnes-2.5-pro-beta' },
  { name: 'agnes-3.0-flash', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-P5tZ5ljBOWyNi85fVzabu633Vp88cmP78d4G7279f6k9KNQj', model: 'agnes-3.0-flash' },
  { name: '商汤 deepseek-v4-flash', baseUrl: 'https://token.sensenova.cn/v1', apiKey: 'sk-F3WGt9cnsCrduZMyhyTYMEEKYJWE1Mzn', model: 'deepseek-v4-flash' },
  { name: '商汤备用Key deepseek-v4-flash', baseUrl: 'https://token.sensenova.cn/v1', apiKey: 'sk-Pw4XHALKoM3MYleuICN6F2vfp2GP1QUl', model: 'deepseek-v4-flash' },
  { name: 'AMD DeepSeek-V4-Flash', baseUrl: 'https://developer.amd.com.cn/radeon/api/v1', apiKey: 'rc-ee98411a4be1ae0e3522888415af21cad30c3940981af7fa', model: 'DeepSeek-V4-Flash' },
  { name: 'AMD DeepSeek-V4.1-Flash', baseUrl: 'https://developer.amd.com.cn/radeon/api/v1', apiKey: 'rc-ee98411a4be1ae0e3522888415af21cad30c3940981af7fa', model: 'DeepSeek-V4.1-Flash' },
  { name: 'agnes-3.0-flash-max', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-P5tZ5ljBOWyNi85fVzabu633Vp88cmP78d4G7279f6k9KNQj', model: 'agnes-3.0-flash-max' },
  { name: 'agnes-2.5-pro-alpha', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-P5tZ5ljBOWyNi85fVzabu633Vp88cmP78d4G7279f6k9KNQj', model: 'agnes-2.5-pro-alpha' },
  { name: 'agnes-2.5-flash', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-P5tZ5ljBOWyNi85fVzabu633Vp88cmP78d4G7279f6k9KNQj', model: 'agnes-2.5-flash' },
  { name: 'AMD MiMo-V2.6-Flash', baseUrl: 'https://developer.amd.com.cn/radeon/api/v1', apiKey: 'rc-ee98411a4be1ae0e3522888415af21cad30c3940981af7fa', model: 'MiMo-V2.6-Flash' },
  { name: 'AMD DeepSeek-V4-Flash-Vision-Exp', baseUrl: 'https://developer.amd.com.cn/radeon/api/v1', apiKey: 'rc-ee98411a4be1ae0e3522888415af21cad30c3940981af7fa', model: 'DeepSeek-V4-Flash-Vision-Exp' },
  { name: 'AMD Qwen3.8-Flash-Next', baseUrl: 'https://developer.amd.com.cn/radeon/api/v1', apiKey: 'rc-ee98411a4be1ae0e3522888415af21cad30c3940981af7fa', model: 'Qwen3.8-Flash-Next' },
  { name: 'AMD Gemma-4-31B-IT', baseUrl: 'https://developer.amd.com.cn/radeon/api/v1', apiKey: 'rc-ee98411a4be1ae0e3522888415af21cad30c3940981af7fa', model: 'Gemma-4-31B-IT' },
  { name: 'opencode space-bunny-free', baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'sk-NKrrY96pSd8PK2PFjiyb2oJJgNVg6X1iagE1hfPgeDQDECmBejcJAHxdn9Zt8quN', model: 'space-bunny-free' },
  { name: '商汤 glm-5.2', baseUrl: 'https://token.sensenova.cn/v1', apiKey: 'sk-F3WGt9cnsCrduZMyhyTYMEEKYJWE1Mzn', model: 'glm-5.2' },
  { name: '商汤 sensenova-6.8-flash-lite', baseUrl: 'https://token.sensenova.cn/v1', apiKey: 'sk-F3WGt9cnsCrduZMyhyTYMEEKYJWE1Mzn', model: 'sensenova-6.8-flash-lite' },
  { name: 'AMD Qwen3.8-27B', baseUrl: 'https://developer.amd.com.cn/radeon/api/v1', apiKey: 'rc-ee98411a4be1ae0e3522888415af21cad30c3940981af7fa', model: 'Qwen3.8-27B' },
  { name: 'NVIDIA z-ai/glm-5.3-flash', baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: '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', model: 'z-ai/glm-5.3-flash' },
  { name: 'AMD GLM-5.3-Flash', baseUrl: 'https://developer.amd.com.cn/radeon/api/v1', apiKey: 'rc-ee98411a4be1ae0e3522888415af21cad30c3940981af7fa', model: 'GLM-5.3-Flash' },
  { name: '点点笔记 dots3-note-prev', baseUrl: 'https://note3-prev-api.askdiandian.com/v1', apiKey: 'ak_iGxurHneP9HveEQ5cJRuAvZQDJeDI', model: 'dots3-note-prev' },
];

// 会话内记住当前可用的接口，下次请求优先使用（避免反复撞死接口）
let PREFERRED_EP = null;

// 接口健康度（持久化，SW 重启不丢失）：fail 次数越多排越后；成功后清零
const HEALTH_KEY = 'ai_ep_health_v1';
let EP_HEALTH = {};
try {
  chrome.storage.local.get(HEALTH_KEY).then((d) => { EP_HEALTH = d[HEALTH_KEY] || {}; }).catch(() => {});
} catch (_) {}

// 激进熔断：10 分钟内连败 ≥3 次的接口沉底到链尾（其他接口全部失败才再试它），
// 避免每次请求都依次撞死接口、每题耗 25s 超时
const MELT_WINDOW_MS = 10 * 60 * 1000;
const MELT_THRESHOLD = 3;
function isMelted(name) {
  const h = EP_HEALTH[name];
  if (!h || !Array.isArray(h.fails)) return false;
  return h.fails.filter((t) => Date.now() - t < MELT_WINDOW_MS).length >= MELT_THRESHOLD;
}
function recordHealth(name, ok) {
  const h = EP_HEALTH[name] || { fail: 0, lastOk: 0, fails: [] };
  if (ok) { h.fail = 0; h.lastOk = Date.now(); h.fails = []; }
  else {
    h.fail++; h.lastFail = Date.now();
    h.fails = (h.fails || []).filter((t) => Date.now() - t < MELT_WINDOW_MS);
    h.fails.push(Date.now());
    if (h.fails.length > 5) h.fails.shift();
  }
  EP_HEALTH[name] = h;
  try { chrome.storage.local.set({ [HEALTH_KEY]: EP_HEALTH }).catch(() => {}); } catch (_) {}
}

// ---------- 设置存取 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.sync.get(SETTINGS_KEY).then((data) => {
      sendResponse(data[SETTINGS_KEY] || DEFAULT_SETTINGS);
    }).catch(() => sendResponse(DEFAULT_SETTINGS));
    return true; // async
  }

  if (msg.type === 'SAVE_SETTINGS') {
    chrome.storage.sync.set({ [SETTINGS_KEY]: msg.settings }).then(() => {
      sendResponse({ ok: true });
    }).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'AI_CHAT') {
    handleAiChat(msg.payload)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === 'PING') {
    sendResponse({ ok: true, time: Date.now() });
    return false;
  }

  // 未识别消息：不返回 true，让其它监听者处理
  return undefined;
});

// ---------- 响应 schema 校验：弱模型返回不合规类别时视为该接口失败，自动换下一个 ----------
function validateContent(content, expect) {
  if (!expect) return null; // 无校验要求
  let text = String(content || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return '返回中找不到 JSON 数组';
  let arr;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch (_) { return 'JSON 解析失败'; }
  if (!Array.isArray(arr) || !arr.length) return '返回数组为空';
  if (expect.type === 'categories') {
    const set = new Set(expect.categories || []);
    const items = arr.filter((it) => it && it.uid != null);
    const valid = items.filter((it) => set.has(it.category));
    if (!items.length || valid.length < Math.max(1, Math.ceil(items.length * 0.5))) {
      return `返回类别不合规（${valid.length}/${items.length} 在要求类别内，如「${String((arr[0] || {}).category || '').slice(0, 12)}」）`;
    }
  } else if (expect.type === 'domainLabels') {
    const items = arr.filter((it) => it && it.uid != null);
    const valid = items.filter((it) => it.category && String(it.category).length <= 8);
    if (!items.length || valid.length < Math.max(1, Math.ceil(items.length * 0.5))) return '返回领域标签不合规';
  } else if (expect.type === 'uidArray') {
    const valid = arr.filter((x) => (typeof x === 'string' && x) || (x && x.uid != null)).length;
    if (valid === 0) return '返回 uid 列表不合规';
  }
  return null;
}

// ---------- 单个接口的请求（含限流重试与超时） ----------
// 稳定性策略：单请求 25s 超时（实测可用接口均在 15s 内，慢接口直接淘汰）；
// 重试只给主接口，备用链上的接口失败立即换下一个，避免整条链被拖死。
async function tryEndpoint(ep, payload, temperature, retries = 0) {
  const url = ep.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: ep.model,
    messages: payload.messages || [],
    temperature,
    stream: false,
  };

  const MAX_ATTEMPTS = retries + 1;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + ep.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000), // 单请求 25s 超时，防止慢接口卡死整条链
      });
    } catch (e) {
      const msg = (e && e.name === 'TimeoutError') ? '请求超时（25s）'
        : '网络请求失败：' + (e && e.message || e);
      return { ok: false, error: msg, network: true };
    }

    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }

    const text = await resp.text();
    if (!resp.ok) {
      let hint = '';
      try {
        const j = JSON.parse(text);
        hint = (j.error && (j.error.message || j.error.code)) || text.slice(0, 200);
      } catch (_) { hint = text.slice(0, 200); }
      return { ok: false, error: `接口返回 ${resp.status}：${hint}`, status: resp.status };
    }

    try {
      const j = JSON.parse(text);
      const msg = j.choices && j.choices[0] && j.choices[0].message;
      const content = msg && (msg.content || msg.reasoning_content || msg.reasoning);
      if (!content) return { ok: false, error: '接口返回内容为空：' + text.slice(0, 200) };
      const verr = validateContent(content, payload.expect);
      if (verr) return { ok: false, error: verr };
      return { ok: true, content, usage: j.usage || null };
    } catch (e) {
      return { ok: false, error: '接口返回不是合法 JSON：' + text.slice(0, 200) };
    }
  }
}

// ---------- 带故障转移的 AI 请求 ----------
async function handleAiChat(payload) {
  const settings = await loadSettings();
  const temperature = typeof payload.temperature === 'number' ? payload.temperature : settings.temperature;

  // 弹窗「测试连通性」会显式携带 baseUrl/apiKey：只测用户指定的接口，不转移
  if (payload.baseUrl && payload.apiKey) {
    const ep = {
      name: '指定接口',
      baseUrl: String(payload.baseUrl).replace(/\/+$/, ''),
      apiKey: payload.apiKey,
      model: payload.model || settings.model,
    };
    const r = await tryEndpoint(ep, payload, temperature, 1);
    return r.ok ? r : Object.assign({ ok: false }, r);
  }

  // 常规请求：主设置 + 备用链，自动故障转移
  const primary = {
    name: '我的设置',
    baseUrl: (settings.baseUrl || '').replace(/\/+$/, ''),
    apiKey: settings.apiKey || '',
    model: settings.model || 'gpt-4o-mini',
  };
  if (!primary.baseUrl || !primary.apiKey) {
    return { ok: false, error: '未配置 AI 接口地址或 API Key，请先在插件弹窗中完成设置。' };
  }

  const chain = [primary, ...FALLBACK_ENDPOINTS.filter(
    (f) => f.baseUrl !== primary.baseUrl || f.apiKey !== primary.apiKey
  )];
  // 会话内可用过的接口优先
  if (PREFERRED_EP) {
    const idx = chain.findIndex((e) => e.baseUrl === PREFERRED_EP.baseUrl && e.apiKey === PREFERRED_EP.apiKey);
    if (idx > 0) chain.unshift(...chain.splice(idx, 1));
  }
  // 健康度排序：连续失败的接口排后面（Array.sort 稳定，同分保持原优先级）
    // 健康度排序：失败次数多的排后；90 秒内刚失败过的额外重罚（冷却期），
  // 并发请求会自动分散到不同接口，避免多个 worker 扎堆同一个限流接口
  const hf = (e) => {
    const h = EP_HEALTH[e.name] || { fail: 0 };
    const cooling = h.lastFail && (Date.now() - h.lastFail < 90000) ? 6 : 0;
    return (h.fail || 0) + cooling;
  };
  chain.sort((a, b) => hf(a) - hf(b));

  // 熔断沉底：被拉黑的接口放链尾（其余全挂时才轮到它们，死接口不再拖慢正常请求）
  const live = chain.filter((e) => !isMelted(e.name));
  const melted = chain.filter((e) => isMelted(e.name));
  if (melted.length) console.warn('[AI取关] 熔断沉底', melted.length, '个接口：', melted.map((e) => e.name).join('、'));
  chain.length = 0;
  chain.push(...live, ...melted);

  const errors = [];
  for (const ep of chain) {
    const r = await tryEndpoint(ep, payload, temperature, ep === chain[0] ? 1 : 0);
    recordHealth(ep.name, r.ok);
    if (r.ok) {
      PREFERRED_EP = ep;
      if (ep !== chain[0]) console.warn('[AI取关] 已自动切换到备用接口：', ep.name);
      return { ok: true, content: r.content, usage: r.usage, via: ep.name };
    }
    errors.push(`${ep.name} → ${r.error}`);
    console.warn('[AI取关] 接口失败，尝试下一个：', errors[errors.length - 1]);
  }

  const lastErr = errors[errors.length - 1] || '未知错误';
  return {
    ok: false,
    error: `所有接口均失败（已自动尝试 ${errors.length} 个备用）。最后错误：${lastErr}。修复建议：打开插件弹窗，点「一键修复接口权限」勾选全部网站访问权限后重试；若仍失败请稍后再试。`,
  };
}

async function loadSettings() {
  try {
    const data = await chrome.storage.sync.get(SETTINGS_KEY);
    return Object.assign({}, DEFAULT_SETTINGS, data[SETTINGS_KEY] || {});
  } catch (_) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}
