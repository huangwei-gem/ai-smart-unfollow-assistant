// ============================================================
// AI 接口全量测试（用户提供的端点）
// 每个候选模型测：连通性 / 鉴权 / 延迟 / 分类 JSON 输出质量 / CORS
// 结果写入 _test/ai-endpoints-result.json
// ============================================================
import fs from 'node:fs';

const ACCOUNTS = [
  { uid: '1001', name: '官方知识频道', sign: '每周更新硬核知识' },
  { uid: '1002', name: '测试推广号A', sign: '关注领福利' },
  { uid: '1003', name: '路人甲', sign: '高中同学' },
];
const VALID_CATS = ['常看博主', '可能认识', '僵尸号', '营销号', '不感兴趣'];
const SYS = '你是严谨的账号分类器。只输出 JSON 数组，不要任何多余文字。元素形如 {"uid":"...","category":"..."}，category 只能取：常看博主/可能认识/僵尸号/营销号/不感兴趣。';
const USER = '请分类以下账号：\n' + JSON.stringify(ACCOUNTS.map(a => ({ uid: a.uid, name: a.name, sign: a.sign })));

const ENDPOINTS = [
  { label: 'Agnes AI', base: 'https://apihub.agnes-ai.com/v1', key: 'sk-P5tZ5ljBOWyNi85fVzabu633Vp88cmP78d4G7279f6k9KNQj', models: ['agnes-2.5-flash'] },
  { label: 'SenseNova A', base: 'https://token.sensenova.cn/v1', key: 'sk-F3WGt9cnsCrduZMyhyTYMEEKYJWE1Mzn', models: ['deepseek-v4-flash'] },
  { label: 'SenseNova B', base: 'https://token.sensenova.cn/v1', key: 'sk-Pw4XHALKoM3MYleuICN6F2vfp2GP1QUl', models: ['deepseek-v4-flash'] },
  { label: '点点笔记', base: 'https://note3-prev-api.askdiandian.com/v1', key: 'ak_iGxurHneP9HveEQ5cJRuAvZQDJeDI', models: ['dots3-note-prev'] },
  { label: 'AMD Radeon', base: 'https://developer.amd.com.cn/radeon/api/v1', key: 'rc-ee98411a4be1ae0e3522888415af21cad30c3940981af7fa', models: ['DeepSeek-V4.1-Flash', 'GLM-5.3-Flash', 'Qwen3.8-Flash-Next'] },
  { label: 'NVIDIA NIM', base: 'https://integrate.api.nvidia.com/v1', key: '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', models: ['glm-5-3', 'glm-5-3-flash', 'kimi-k3', 'deepseek-v4-flash-0731'] },
  { label: 'OpenCode Zen', base: 'https://opencode.ai/zen/v1', key: 'sk-NKrrY96pSd8PK2PFjiyb2oJJgNVg6X1iagE1hfPgeDQDECmBejcJAHxdn9Zt8quN', models: [], freeOnly: true },
];

async function timedFetch(url, opts = {}, timeoutMs = 45000) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    return { r, ms: Date.now() - t0 };
  } catch (e) {
    return { err: e.message || String(e), ms: Date.now() - t0 };
  }
}

function parseCategories(content) {
  if (typeof content !== 'string') return { ok: false, why: 'content 非字符串' };
  let text = content.replace(/```(?:json)?/gi, '').trim();
  const s = text.indexOf('['), e = text.lastIndexOf(']');
  if (s === -1 || e === -1) return { ok: false, why: '未找到 JSON 数组', raw: content.slice(0, 120) };
  try {
    const arr = JSON.parse(text.slice(s, e + 1));
    if (!Array.isArray(arr) || arr.length === 0) return { ok: false, why: '数组为空' };
    const bad = arr.filter(x => !x || !x.uid || !VALID_CATS.includes(x.category));
    if (bad.length) return { ok: false, why: `${bad.length} 项类别非法或缺 uid`, sample: arr[0] };
    return { ok: true, count: arr.length, categories: arr.map(x => x.category) };
  } catch (err) { return { ok: false, why: 'JSON 解析失败: ' + err.message, raw: text.slice(0, 120) }; }
}

async function listModels(ep) {
  const { r, err, ms } = await timedFetch(ep.base + '/models', { headers: { Authorization: `Bearer ${ep.key}` } }, 20000);
  if (err) return { ok: false, err, ms };
  if (!r.ok) return { ok: false, err: `HTTP ${r.status}`, ms };
  try {
    const j = await r.json();
    const ids = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
    return { ok: true, count: ids.length, ids, acao: r.headers.get('access-control-allow-origin') };
  } catch (e) { return { ok: false, err: 'models JSON 解析失败', ms }; }
}

async function testChat(ep, model) {
  const t0 = Date.now();
  const { r, err, ms } = await timedFetch(ep.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: SYS }, { role: 'user', content: USER }], temperature: 0.2 }),
  }, 60000);
  if (err) return { model, ok: false, err, ms };
  const acao = r.headers.get('access-control-allow-origin');
  let j = null, raw = '';
  try { raw = await r.text(); j = JSON.parse(raw); } catch (_) {}
  if (!r.ok) return { model, ok: false, http: r.status, err: (j && (j.error?.message || j.message)) || raw.slice(0, 120), ms, acao };
  const content = j?.choices?.[0]?.message?.content;
  const cat = parseCategories(content);
  return { model, ok: cat.ok === true, http: r.status, ms, acao, usage: j?.usage, ...cat };
}

async function testPreflight(ep, model) {
  const { r, err } = await timedFetch(ep.base + '/chat/completions', {
    method: 'OPTIONS',
    headers: {
      'Origin': 'chrome-extension://fpegjpeohcikjpjapcnbnecpmbdelbig',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type',
    },
  }, 15000);
  if (err) return { preflight: false, err };
  const acao = r.headers.get('access-control-allow-origin');
  const acam = r.headers.get('access-control-allow-methods');
  const acah = r.headers.get('access-control-allow-headers');
  const browserOk = acao && (acao === '*' || acao.includes('chrome-extension'));
  return { preflight: true, status: r.status, acao, acam, acah, browserOk };
}

// ============================================================
const OUT = [];
for (const ep of ENDPOINTS) {
  console.log(`\n===== ${ep.label} (${ep.base}) =====`);
  // 1) 模型列表
  const ml = await listModels(ep);
  if (ml.ok) {
    console.log(`models: ${ml.count} 个${ml.freeOnly ? '（需筛选 Free）' : ''} | acao=${ml.acao}`);
    if (ep.freeOnly) {
      const free = ml.ids.filter(id => /free/i.test(id));
      console.log('Free 模型:', free.slice(0, 10).join(', ') || '（无）');
      ep.models = free.slice(0, 4); // 最多测 4 个 Free 模型
      if (!ep.models.length) {
        // 找不到 Free 字样时，挑前 2 个模型试测
        ep.models = ml.ids.slice(0, 2);
        console.log('未找到 Free 后缀，试测前 2 个:', ep.models.join(', '));
      }
    }
  } else {
    console.log(`models 列表获取失败: ${ml.err} (${ml.ms}ms)`);
  }

  // 2) 逐模型 chat 测试
  for (const model of ep.models) {
    const res = await testChat(ep, model);
    const pf = await testPreflight(ep, model);
    const row = { endpoint: ep.label, base: ep.base, ...res, cors: pf };
    OUT.push(row);
    console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${model}  http=${res.http} ${res.ms}ms  分类=${res.ok ? '有效' : res.why || res.err}  acao=${res.acao}  浏览器直连=${pf.browserOk === true}`);
  }
}

fs.writeFileSync(new URL('./ai-endpoints-result.json', import.meta.url), JSON.stringify(OUT, null, 2));
const pass = OUT.filter(r => r.ok).length;
console.log(`\n==== AI 接口测试：${pass}/${OUT.length} 个模型可用 ====`);
console.log(OUT.filter(r => r.ok).map(r => `${r.endpoint} | ${r.model}`).join('\n'));
process.exit(0);
