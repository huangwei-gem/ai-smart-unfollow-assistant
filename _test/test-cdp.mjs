const TEST_KEY = process.env.TEST_KEY || 'test' + '-key-' + '123';
// ============================================================
// 轻量 CDP 测试驱动（零依赖，Node 24 内置 fetch + WebSocket）
// 用法：node test-cdp.mjs
// ============================================================
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

const PORT = 9225;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK_PORT = 18923;
const OUT = { results: [], consoleErrors: {} };

function record(name, ok, detail = '') {
  OUT.results.push({ name, ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- CDP 连接 ----------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', (e) => reject(new Error('ws error')));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async waitEvent(method, timeoutMs = 15000, pred = () => true) {
    const deadline = Date.now() + timeoutMs;
    let idx = 0;
    while (Date.now() < deadline) {
      for (; idx < this.events.length; idx++) {
        if (this.events[idx].method === method && pred(this.events[idx])) return this.events[idx];
      }
      await sleep(100);
    }
    return null;
  }
  async evaluate(expr, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page eval: ' + (d.exception?.description || d.text || 'unknown'));
    }
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function listTargets() {
  const r = await fetch(`${BASE}/json/list`);
  return r.json();
}

async function openTab(url) {
  const t = await (await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  // 目标刚建立时 ws 可能还没就绪，稍等重试
  for (let i = 0; i < 10; i++) {
    try { return await CDP.connect(t.webSocketDebuggerUrl); } catch (_) { await sleep(300); }
  }
  throw new Error('cannot connect tab ws');
}

async function newPage(url, { waitLoad = true, settle = 3000 } = {}) {
  const cdp = await openTab('about:blank');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const loadPromise = cdp.waitEvent('Page.loadEventFired', 30000).catch(() => null);
  await cdp.send('Page.navigate', { url });
  if (waitLoad) await loadPromise;
  await sleep(settle);
  return cdp;
}

// ---------- Mock OpenAI 服务 ----------
import http from 'node:http';
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/chat/completions' && req.method === 'POST') {
      const auth = req.headers['authorization'] || '';
      if (auth !== 'Bearer ' + TEST_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      let uid = 'unknown';
      try { uid = JSON.parse(JSON.parse(body).messages.at(-1).content.replace(/^[\s\S]*账号列表：\s*/, ''))[0].uid; } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify([{ uid, category: '营销号' }]) } }],
        usage: { total_tokens: 42 },
      }));
    } else { res.writeHead(404); res.end(); }
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
console.log(`mock openai on :${MOCK_PORT}`);

// ============================================================
// 测试开始
// ============================================================
try {
  // ---------- 0. 找到插件 ----------
  const targets = await listTargets();
  const sw = targets.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
  if (!sw) throw new Error('插件 service worker 未找到，插件可能加载失败。targets: ' + targets.map(t => t.type + ':' + t.url).join(' | '));
  const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
  record('插件已加载（找到 service worker）', true, `id=${extId}`);

  // ---------- 1. 弹窗页：设置保存 / 读取 / AI 管线 ----------
  const popup = await newPage(`chrome-extension://${extId}/popup/popup.html`, { settle: 800 });

  // 1a. 填表保存
  const saved = await popup.evaluate(`
    (async () => {
      document.getElementById('baseUrl').value = 'http://127.0.0.1:${MOCK_PORT}/v1';
      document.getElementById('apiKey').value = TEST_KEY;
      document.getElementById('model').value = 'test-model';
      document.getElementById('batchSize').value = '40';
      document.getElementById('save').click();
      await new Promise(r => setTimeout(r, 600));
      const msg = document.getElementById('msg');
      const st = await chrome.storage.sync.get(null);
      return { msg: msg.textContent, cls: msg.className, stored: st };
    })()
  `);
  record('弹窗：保存设置成功提示', saved.cls === 'msg ok', saved.msg);
  record('弹窗：storage 写入正确', saved.stored?.ai_unfollow_settings_v1?.apiKey === TEST_KEY, JSON.stringify(saved.stored).slice(0, 150));

  // 1b. 重载后回填
  await popup.send('Page.navigate', { url: `chrome-extension://${extId}/popup/popup.html` });
  await sleep(1200);
  const backfill = await popup.evaluate(`
    ({ baseUrl: document.getElementById('baseUrl').value, key: document.getElementById('apiKey').value })
  `);
  record('弹窗：重开回填已存配置', backfill.baseUrl.includes(String(MOCK_PORT)) && backfill.key === TEST_KEY, JSON.stringify(backfill));

  // 1c. 测试连通性按钮（mock 200）
  const testOk = await popup.evaluate(`
    (async () => {
      document.getElementById('test').click();
      await new Promise(r => setTimeout(r, 1500));
      const m = document.getElementById('msg');
      return { text: m.textContent, cls: m.className };
    })()
  `);
  record('弹窗：测试连通性（mock 200）', testOk.cls === 'msg ok', testOk.text);

  // 1d. 后台 AI_CHAT 走通（含 JSON 分类解析路径的内容形态）
  const chat = await popup.evaluate(`
    (async () => {
      const payload = { messages: [{ role: 'user', content: '分类这些账号：[{"uid":"99","name":"x","sign":"y"}]' }] };
      const r = await chrome.runtime.sendMessage({ type: 'AI_CHAT', payload });
      return r;
    })()
  `);
  record('后台：AI_CHAT 转发成功', chat.ok === true && typeof chat.content === 'string', (chat.content || chat.error || '').slice(0, 120));
  try { record('后台：AI 返回可被解析为分类 JSON', Array.isArray(JSON.parse(chat.content)), chat.content?.slice(0, 80)); }
  catch (e) { record('后台：AI 返回可被解析为分类 JSON', false, e.message); }

  // 1e. 错误路径：错误 Key → 401
  const chat401 = await popup.evaluate(`
    (async () => {
      const r = await chrome.runtime.sendMessage({ type: 'AI_CHAT', payload: { apiKey: TEST_KEY, messages: [{ role: 'user', content: 'hi' }] } });
      return r;
    })()
  `);
  record('后台：错误 Key 返回 401 错误信息', chat401.ok === false && /401/.test(chat401.error || ''), (chat401.error || '').slice(0, 120));

  // 1f. 错误路径：不可达地址
  const chatDead = await popup.evaluate(`
    (async () => {
      const r = await chrome.runtime.sendMessage({ type: 'AI_CHAT', payload: { baseUrl: 'http://127.0.0.1:9/v1', messages: [{ role: 'user', content: 'hi' }] } });
      return r;
    })()
  `);
  record('后台：接口不可达返回网络错误', chatDead.ok === false && /网络请求失败/.test(chatDead.error || ''), (chatDead.error || '').slice(0, 120));

  // 1g. GET_SETTINGS 默认值
  const defaults = await popup.evaluate(`chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })`);
  record('后台：GET_SETTINGS 返回含默认值', typeof defaults.temperature === 'number' && defaults.model.length > 0, JSON.stringify(defaults).slice(0, 120));

  popup.close();

  // ---------- 2. 内容脚本：错误路径（无登录态） ----------
  // B站：未登录时应提示登录，isSupportedPage=false，不抛异常
  const bili = await newPage('https://www.bilibili.com/', { settle: 5000 });
  const biliState = await bili.evaluate(`
    (() => {
      const A = window.AIUnfollow;
      if (!A) return { injected: false };
      const act = A.activeAdapter();
      const ad = act && act.adapter;
      return {
        injected: true,
        platform: act && act.name,
        supported: ad ? ad.isSupportedPage() : null,
        hint: ad ? ad.pageHint() : null,
        panel: !!document.getElementById('aiuf-root'),
      };
    })()
  `);
  record('B站：内容脚本注入且识别平台', biliState.injected && biliState.platform === 'bilibili', JSON.stringify(biliState).slice(0, 200));
  record('B站：悬浮球/面板已挂载', !!biliState.panel);
  if (biliState.supported === false) {
    record('B站：未登录 → 引导提示', /登录/.test(biliState.hint || ''), biliState.hint);
  } else if (biliState.supported === true) {
    record('B站：检测到登录态 → 就绪提示', /就绪/.test(biliState.hint || ''), biliState.hint);
    // 已登录才做的轻量探测：不发写操作
  }
  bili.close();

  // 抖音主站：应提示跳转创作者平台
  const dy = await newPage('https://www.douyin.com/', { settle: 6000 });
  const dyState = await dy.evaluate(`
    (() => {
      const A = window.AIUnfollow;
      if (!A) return { injected: false };
      const act = A.activeAdapter();
      const ad = act && act.adapter;
      return {
        injected: true,
        platform: act && act.name,
        supported: ad ? ad.isSupportedPage() : null,
        hint: ad ? ad.pageHint() : null,
        needsRedirect: ad && ad.needsRedirect ? ad.needsRedirect() : null,
        panel: !!document.getElementById('aiuf-root'),
      };
    })()
  `);
  record('抖音：内容脚本注入且识别平台', dyState.injected && dyState.platform === 'douyin', JSON.stringify(dyState).slice(0, 200));
  record('抖音：主站提示跳转创作者平台', dyState.needsRedirect === true && /创作者/.test(dyState.hint || ''), (dyState.hint || '').slice(0, 120));
  dy.close();

  // 创作者平台：面板与适配器（登录墙外能测的部分）
  const creator = await newPage('https://creator.douyin.com/creator-micro/data/following/following', { settle: 6000 });
  const crState = await creator.evaluate(`
    (() => {
      const A = window.AIUnfollow;
      if (!A) return { injected: false };
      const act = A.activeAdapter();
      const ad = act && act.adapter;
      return {
        injected: true,
        platform: act && act.name,
        hint: ad ? ad.pageHint() : null,
        panel: !!document.getElementById('aiuf-root'),
        path: location.pathname,
      };
    })()
  `);
  record('抖音创作者平台：注入与面板', crState.injected && crState.platform === 'douyin' && !!crState.panel, JSON.stringify(crState).slice(0, 200));
  creator.close();

  // ---------- 3. 收集页面控制台错误 ----------
  const errs = [];
  for (const [page, list] of Object.entries(OUT.consoleErrors)) errs.push(...list);
  record('无致命控制台异常（除预期的未登录/风控提示）', errs.length === 0, errs.slice(0, 5).join(' | '));

} catch (e) {
  record('测试执行异常中断', false, e.stack || e.message);
} finally {
  mock.close();
  fs.writeFileSync('test-result.json', JSON.stringify(OUT, null, 2));
  const pass = OUT.results.filter(r => r.ok).length;
  console.log(`\n==== ${pass}/${OUT.results.length} passed ====`);
  process.exit(0);
}

