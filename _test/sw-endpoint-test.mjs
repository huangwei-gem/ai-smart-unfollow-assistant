// 在 CFT Chrome 的扩展 SW 环境里测试 agnes / opencode / amd / nvidia / sensenova
import WebSocket from 'ws';
import fs from 'node:fs';

const EXT_ID = 'fpegjpeohcikjpjapcnbnecpmbdelbig';
const PORT = 9225;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ws, send };
}

async function evalInSw(send, expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) return { error: JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 300) };
  return r.result?.result?.value;
}

const TEST = `
(async () => {
  const out = {};
  const eps = {
    agnes: 'https://apihub.agnes-ai.com/v1|sk-P5tZ5ljBOWyNi85fVzabu633Vp88cmP78d4G7279f6k9KNQj',
    opencode: 'https://opencode.ai/zen/v1|sk-NKrrY96pSd8PK2PFjiyb2oJJgNVg6X1iagE1hfPgeDQDECmBejcJAHxdn9Zt8quN',
    amd: 'https://developer.amd.com.cn/radeon/api/v1|rc-ee98411a4be1ae0e3522888415af21cad30c3940981af7fa',
  };
  const accounts = [{uid:'u1',name:'美食家小王',sign:'家常菜教程'},{uid:'u2',name:'引流课堂',sign:'加微信领资料'},{uid:'u3',name:'旅行日记',sign:'记录旅行'}];

  async function listModels(base, key) {
    try {
      const r = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(25000) });
      const t = await r.text();
      try { const j = JSON.parse(t); const arr = j.data || j.models || []; return { status: r.status, ids: arr.map(m => m.id || m.name || m).filter(Boolean) }; }
      catch (_) { return { status: r.status, body: t.slice(0, 120) }; }
    } catch (e) { return { error: String(e && e.message || e) }; }
  }
  async function chat(base, key, model) {
    const t0 = Date.now();
    try {
      const r = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, temperature: 0.2, stream: false, messages: [
          { role: 'system', content: '你是严谨的分类器，只输出要求的 JSON。' },
          { role: 'user', content: '把账号分为「常看」或「取关」，输出 [{"uid":"...","category":"常看|取关"}]：' + JSON.stringify(accounts) },
        ]}),
        signal: AbortSignal.timeout(60000),
      });
      const text = await r.text();
      if (!r.ok) return { ok: false, status: r.status, ms: Date.now() - t0, body: text.slice(0, 120) };
      const j = JSON.parse(text);
      const c = j.choices?.[0]?.message?.content || '';
      // 严格判定：回复里必须能解析出覆盖全部 uid 的合格分类 JSON
      let parsed = null;
      try {
        const s = c.indexOf('['), e = c.lastIndexOf(']');
        parsed = JSON.parse(c.slice(s, e + 1));
      } catch (_) {}
      const allUids = Array.isArray(parsed) && accounts.every(a => parsed.some(x => x.uid === a.uid && /常看|取关/.test(x.category || '')));
      return { ok: allUids, ms: Date.now() - t0, sample: c.slice(0, 160) };
    } catch (e) { return { ok: false, ms: Date.now() - t0, error: String(e && e.message || e) }; }
  }

  for (const [name, cfg] of Object.entries(eps)) {
    const [base, key] = cfg.split('|');
    out[name] = { models: await listModels(base, key), chats: {} };
    let ids = out[name].models.ids || [];
    if (name === 'opencode') ids = ids.filter(i => /free/i.test(i));
    if (name === 'agnes' && !ids.length) ids = ['agnes-2.5-flash'];
    if (name === 'amd' && !ids.length) ids = ['GLM-5.3-Flash', 'Qwen3.8-Flash-Next', 'DeepSeek-V4.1-Flash'];
    ids = ids.slice(0, 10);
    for (const id of ids) out[name].chats[id] = await chat(base, key, id);
  }
  // NVIDIA 定向测试
  const nvKey = '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';
  const nvBase = 'https://integrate.api.nvidia.com/v1';
  out.nvidia = { chats: {} };
  for (const id of ['z-ai/glm-5.3-flash', 'moonshotai/kimi-k3', 'deepseek-ai/deepseek-v4-flash-0731', 'deepseek-ai/deepseek-v4.1-flash']) {
    out.nvidia.chats[id] = await chat(nvBase, nvKey, id);
  }
  // 商汤 deepseek-flash（上次 429，重试）
  const ssKey = 'sk-F3WGt9cnsCrduZMyhyTYMEEKYJWE1Mzn';
  out.sensenova = { chats: {} };
  for (const id of ['deepseek-flash', 'sensenova-6.8-flash-lite']) {
    out.sensenova.chats[id] = await chat('https://token.sensenova.cn/v1', ssKey, id);
  }
  return JSON.stringify(out);
})()
`;

async function main() {
  // 唤醒 SW：先等 target 出现
  let swUrl = null;
  for (let i = 0; i < 10; i++) {
    const targets = await getTargets();
    const sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
    if (sw) { swUrl = sw.webSocketDebuggerUrl; break; }
    // 打开 popup 唤醒
    try { await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${EXT_ID}/popup/popup.html`, { method: 'PUT' }); } catch (_) {}
    await sleep(1500);
  }
  if (!swUrl) { console.error('SW target not found'); process.exit(1); }
  const { ws, send } = await connect(swUrl);
  const result = await evalInSw(send, TEST);
  fs.writeFileSync(new URL('./sw-endpoints-result.json', import.meta.url), result);
  const o = JSON.parse(result);
  for (const [ep, d] of Object.entries(o)) {
    console.error(`\n=== ${ep} ===`);
    if (d.models) console.error('models:', d.models.error || d.models.status, (d.models.ids || []).slice(0, 15).join(', ') || d.models.body || '');
    for (const [m, r] of Object.entries(d.chats || {})) {
      console.error(`  [${r.ok ? 'OK ' : 'FAIL'}] ${m} ${r.ms}ms ${r.ok ? r.sample.slice(0, 40) : (r.error || r.status + ' ' + (r.body || '')).slice(0, 100)}`);
    }
  }
  ws.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
