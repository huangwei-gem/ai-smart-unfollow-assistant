// 扫描所有 AI 接口的 /models 清单 + 逐模型 chat 实测
import fs from 'node:fs';

const ENDPOINTS = [
  { name: 'agnes', base: 'https://apihub.agnes-ai.com/v1', key: 'sk-P5tZ5ljBOWyNi85fVzabu633Vp88cmP78d4G7279f6k9KNQj' },
  { name: 'sensenova', base: 'https://token.sensenova.cn/v1', key: 'sk-F3WGt9cnsCrduZMyhyTYMEEKYJWE1Mzn' },
  { name: 'diandian', base: 'https://note3-prev-api.askdiandian.com/v1', key: 'ak_iGxurHneP9HveEQ5cJRuAvZQDJeDI' },
  { name: 'amd', base: 'https://developer.amd.com.cn/radeon/api/v1', key: 'rc-ee98411a4be1ae0e3522888415af21cad30c3940981af7fa' },
  { name: 'nvidia', base: 'https://integrate.api.nvidia.com/v1', key: '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' },
  { name: 'opencode', base: 'https://opencode.ai/zen/v1', key: 'sk-NKrrY96pSd8PK2PFjiyb2oJJgNVg6X1iagE1hfPgeDQDECmBejcJAHxdn9Zt8quN' },
];

const accounts = [
  { uid: 'u1', name: '美食家小王', sign: '每周更新家常菜教程' },
  { uid: 'u2', name: '低价引流课堂', sign: '零基础月入过万 加微信领取资料' },
  { uid: 'u3', name: '旅行日记', sign: '记录走过的地方' },
];

async function listModels(ep) {
  try {
    const r = await fetch(ep.base + '/models', {
      headers: { Authorization: 'Bearer ' + ep.key },
      signal: AbortSignal.timeout(30000),
    });
    const t = await r.text();
    let ids = [];
    try {
      const j = JSON.parse(t);
      const arr = j.data || j.models || j.result || [];
      ids = arr.map((m) => m.id || m.name || m).filter(Boolean);
    } catch (_) { return { ok: false, status: r.status, body: t.slice(0, 200) }; }
    return { ok: r.ok, status: r.status, count: ids.length, ids };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function chat(ep, model) {
  const t0 = Date.now();
  try {
    const r = await fetch(ep.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ep.key },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是严谨的分类器，只输出要求的 JSON。' },
          { role: 'user', content: `把账号分为「常看」或「取关」两类，输出 JSON 数组 [{"uid":"...","category":"常看|取关"}]：${JSON.stringify(accounts)}` },
        ],
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(90000),
    });
    const text = await r.text();
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, status: r.status, ms, body: text.slice(0, 160) };
    const j = JSON.parse(text);
    const content = j.choices?.[0]?.message?.content || '';
    const good = content.includes('uid');
    return { ok: good, ms, sample: content.slice(0, 120) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e && e.message || e) };
  }
}

const out = {};
for (const ep of ENDPOINTS) {
  console.error(`\n===== ${ep.name} (${ep.base}) =====`);
  const m = await listModels(ep);
  out[ep.name] = { modelsList: m, chats: {} };
  if (m.ok && m.ids?.length) {
    console.error(`models(${m.count}):`, m.ids.slice(0, 40).join(', '));
    // 每个模型实测（最多 12 个/接口，控制时间）
    const targets = m.ids.slice(0, 12);
    for (const id of targets) {
      const r = await chat(ep, id);
      out[ep.name].chats[id] = r;
      console.error(`  [${r.ok ? 'OK ' : 'FAIL'}] ${id} ${r.ms}ms ${r.ok ? '' : (r.error || r.status || '').toString().slice(0, 90)}`);
    }
  } else {
    console.error('models list failed:', JSON.stringify(m).slice(0, 200));
  }
}
fs.writeFileSync(new URL('./ai-models-scan-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.error('\nDONE -> _test/ai-models-scan-result.json');
