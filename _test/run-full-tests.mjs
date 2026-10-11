// ============================================================
// 全链路测试驱动（CDP，零依赖，Node 24 内置 fetch + WebSocket）
// 前置：CFT Chrome 已以 --load-extension=ext2 --remote-debugging-port=9225 启动
//       mock AI 服务已监听 http://127.0.0.1:18923/v1（key: test-key-123）
// 覆盖：
//   A. 扩展加载（service worker）
//   B. popup：设置保存/回填/连通测试/AI_CHAT 转发/错误路径/默认值
//   C. 内容脚本真实注入：B站/抖音主站/创作者平台 + 面板 UI + CSS
//   D. 面板状态机全流程（隔离世界 patch fetchFollowing → 伪造账号，
//      AI 分类走真实 service worker → mock，执行阶段因未登录安全失败）
// 全程只读真实平台，不执行任何真实取关。
// ============================================================
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

const PORT = 9225;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK_PORT = 18923;
const TEST_KEY = 'test-key-123';
const OUT = { results: [], consoleErrors: {} };

function record(name, ok, detail = '') {
  OUT.results.push({ name, ok, detail: String(detail).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------- CDP ----------
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    this.contexts = new Map(); // contextId -> {id, name, auxData}
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (msg.method === 'Runtime.executionContextCreated') {
          const c = msg.params.context;
          this.contexts.set(c.id, c);
        }
      }
    });
  }
  static async connect(url) {
    for (let i = 0; i < 10; i++) {
      try {
        const ws = new WebSocket(url);
        await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
        return new CDP(ws);
      } catch (_) { await sleep(300); }
    }
    throw new Error('ws connect failed');
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      this.pending.set(++this.id, { resolve, reject });
      this.ws.send(JSON.stringify({ id: this.id, method, params }));
    });
  }
  async evaluate(expr, opts = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, ...opts,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page eval: ' + (d.exception?.description || d.text || 'unknown'));
    }
    return r.result.value;
  }
  async evalInIsolatedWorld(expr, timeoutMs = 8000) {
    // 找到当前 frame 的隔离世界上下文（content script 所在世界）
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const c of this.contexts.values()) {
        if (c.auxData && c.auxData.type === 'isolated') {
          const r = await this.send('Runtime.evaluate', {
            expression: expr, awaitPromise: true, returnByValue: true, contextId: c.id,
          });
          if (r.exceptionDetails) {
            throw new Error('isolated eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
          }
          return r.result.value;
        }
      }
      await sleep(200);
    }
    throw new Error('未找到隔离世界上下文（content script 未注入？）');
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
  async collectErrors(tag) {
    const errs = [];
    for (const m of this.events) {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errs.push((d.exception?.description || d.text || '').slice(0, 200));
      }
    }
    if (errs.length) OUT.consoleErrors[tag] = errs;
    return errs;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function openTab(url) {
  const t = await (await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
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

// 伪造关注账号（mock 分类规则：含"测试/推广/营销"→营销号；含"官方/频道"→常看博主；否则僵尸号）
const MOCK_ACCOUNTS = [
  { uid: '1001', name: '官方知识频道', sign: '每周更新硬核知识' },
  { uid: '1002', name: '测试推广号A', sign: '关注领福利' },
  { uid: '1003', name: '路人甲', sign: '' },
  { uid: '1004', name: '带货小卖部', sign: '全场清仓' },
  { uid: '1005', name: '张伟同学', sign: '高中同学' },
  { uid: '1006', name: '睡觉的猫', sign: '' },
];

// ============================================================
try {
  // ---------- A. 扩展加载 ----------
  // MV3 service worker 空闲会被挂起并从 /json/list 消失：先打开扩展页面唤醒，再重试查找
  const findSw = async () => {
    const ts = await (await fetch(`${BASE}/json/list`)).json();
    return ts.find((t) => t.type === 'service_worker' && /background\/service-worker\.js$/.test(t.url));
  };
  let sw = await findSw();
  if (!sw) {
    // 从 profile 的 Preferences 里解析本扩展 ID，打开 popup 页唤醒 service worker
    try {
      const prefsPath = ['Secure Preferences', 'Preferences']
        .map((n) => new URL('./profile3/Default/' + n, import.meta.url))
        .find((u) => { try { fs.accessSync(u); return true; } catch (_) { return false; } });
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      const settings = prefs?.extensions?.settings || {};
      const entry = Object.entries(settings).find(([, v]) => (v.path || '').replace(/\\/g, '/').endsWith('ext2'));
      if (entry) {
        const wakeTab = await openTab(`chrome-extension://${entry[0]}/popup/popup.html`).catch(() => null);
        if (wakeTab) { await sleep(2000); wakeTab.close(); }
      }
    } catch (_) { /* 忽略，走重试 */ }
  }
  for (let i = 0; i < 10 && !sw; i++) {
    await sleep(1000);
    sw = await findSw();
  }
  if (!sw) {
    throw new Error('插件 service worker 未找到（已尝试唤醒）。');
  }
  const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
  record('A1. 扩展已加载，service worker 在运行', true, `id=${extId}`);

  // ---------- B. popup ----------
  const popup = await newPage(`chrome-extension://${extId}/popup/popup.html`, { settle: 800 });

  // B1. 填表保存（TEST_KEY 以字面量注入页面）
  const saved = await popup.evaluate(`
    (async () => {
      document.getElementById('baseUrl').value = 'http://127.0.0.1:${MOCK_PORT}/v1';
      document.getElementById('apiKey').value = '${TEST_KEY}';
      document.getElementById('model').value = 'test-model';
      document.getElementById('batchSize').value = '40';
      document.getElementById('save').click();
      await new Promise(r => setTimeout(r, 800));
      const msg = document.getElementById('msg');
      const st = await chrome.storage.sync.get(null);
      return { msg: msg.textContent, cls: msg.className, stored: st };
    })()
  `);
  record('B1. popup 保存设置成功提示', saved.cls === 'msg ok', saved.msg);
  record('B2. chrome.storage 写入正确', saved.stored?.ai_unfollow_settings_v1?.apiKey === TEST_KEY
    && saved.stored?.ai_unfollow_settings_v1?.baseUrl === `http://127.0.0.1:${MOCK_PORT}/v1`,
    JSON.stringify(saved.stored).slice(0, 180));

  // B3. 重开 popup 后回填
  await popup.send('Page.navigate', { url: `chrome-extension://${extId}/popup/popup.html` });
  await sleep(1200);
  const backfill = await popup.evaluate(`({ baseUrl: document.getElementById('baseUrl').value, key: document.getElementById('apiKey').value, model: document.getElementById('model').value })`);
  record('B3. 重开 popup 回填已存配置', backfill.baseUrl.includes(String(MOCK_PORT)) && backfill.key === TEST_KEY && backfill.model === 'test-model',
    JSON.stringify(backfill));

  // B4. 空表单校验
  const emptyCheck = await popup.evaluate(`
    (async () => {
      document.getElementById('baseUrl').value = ''; document.getElementById('apiKey').value = ''; document.getElementById('model').value = '';
      document.getElementById('save').click();
      await new Promise(r => setTimeout(r, 300));
      const m = document.getElementById('msg');
      return { text: m.textContent, cls: m.className };
    })()
  `);
  record('B4. 空表单保存被拦截并提示', emptyCheck.cls === 'msg err', emptyCheck.text);
  // 恢复表单值
  await popup.evaluate(`
    document.getElementById('baseUrl').value = 'http://127.0.0.1:${MOCK_PORT}/v1';
    document.getElementById('apiKey').value = '${TEST_KEY}';
    document.getElementById('model').value = 'test-model';
  `);

  // B5. 连通性测试（mock 200）
  const testOk = await popup.evaluate(`
    (async () => {
      document.getElementById('test').click();
      await new Promise(r => setTimeout(r, 2000));
      const m = document.getElementById('msg');
      return { text: m.textContent, cls: m.className };
    })()
  `);
  record('B5. 测试连通性按钮（mock 200）', testOk.cls === 'msg ok' && /连通成功/.test(testOk.text), testOk.text);

  // B6. 后台 AI_CHAT 转发 + JSON 可解析
  const chat = await popup.evaluate(`
    (async () => {
      const payload = { messages: [{ role: 'user', content: '分类这些账号：[{"uid":"99","name":"测试号","sign":"y"}]' }] };
      return await chrome.runtime.sendMessage({ type: 'AI_CHAT', payload });
    })()
  `);
  record('B6. 后台 AI_CHAT 转发成功', chat.ok === true && typeof chat.content === 'string', (chat.content || chat.error || '').slice(0, 120));
  try { record('B7. AI 返回可解析为分类 JSON', Array.isArray(JSON.parse(chat.content)), chat.content?.slice(0, 80)); }
  catch (e) { record('B7. AI 返回可解析为分类 JSON', false, e.message); }

  // B8. 错误路径：错误 Key → 401
  const chat401 = await popup.evaluate(`
    (async () => chrome.runtime.sendMessage({ type: 'AI_CHAT', payload: { apiKey: 'wrong-key', messages: [{ role: 'user', content: 'hi' }] } }))()
  `);
  record('B8. 错误 Key → 返回 401 错误信息', chat401.ok === false && /401/.test(chat401.error || ''), (chat401.error || '').slice(0, 140));

  // B9. 错误路径：接口不可达
  const chatDead = await popup.evaluate(`
    (async () => chrome.runtime.sendMessage({ type: 'AI_CHAT', payload: { baseUrl: 'http://127.0.0.1:9/v1', messages: [{ role: 'user', content: 'hi' }] } }))()
  `);
  record('B9. 接口不可达 → 返回网络错误', chatDead.ok === false && /网络请求失败/.test(chatDead.error || ''), (chatDead.error || '').slice(0, 140));

  // B10. GET_SETTINGS 默认值兜底
  const defaults = await popup.evaluate(`chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })`);
  record('B10. GET_SETTINGS 含默认值', typeof defaults.temperature === 'number' && defaults.model.length > 0 && defaults.batchSize >= 5,
    JSON.stringify(defaults).slice(0, 160));

  // B11. PING
  const ping = await popup.evaluate(`chrome.runtime.sendMessage({ type: 'PING' })`);
  record('B11. 后台 PING 存活', ping && ping.ok === true && typeof ping.time === 'number', JSON.stringify(ping));

  const popupErrs = await popup.collectErrors('popup');
  record('B12. popup 无未捕获异常', popupErrs.length === 0, popupErrs.slice(0, 3).join(' | '));
  popup.close();

  // ---------- C. 内容脚本真实注入（manifest content_scripts 生效） ----------
  // C1. B站（未登录）
  const bili = await newPage('https://www.bilibili.com/', { settle: 5000 });
  const biliState = await bili.evaluate(`
    (() => {
      const root = document.getElementById('aiuf-root');
      const ball = document.getElementById('aiuf-ball');
      const cs = root ? getComputedStyle(root) : null;
      return {
        injected: !!root, ball: !!ball,
        rootFixed: cs ? cs.position === 'fixed' : false,
        cssApplied: cs ? parseInt(cs.zIndex, 10) > 2000000000 : false,
      };
    })()
  `);
  record('C1. B站：内容脚本注入（面板 root 挂载）', biliState.injected && biliState.ball, JSON.stringify(biliState));
  record('C2. B站：panel.css 已注入（#aiuf-root fixed/高 z-index）', biliState.rootFixed && biliState.cssApplied, JSON.stringify(biliState));

  const biliIso = await bili.evalInIsolatedWorld(`
    (() => {
      const A = window.AIUnfollow;
      if (!A) return { injected: false };
      const act = A.activeAdapter();
      const ad = act && act.adapter;
      return { injected: true, platform: act && act.name,
        supported: ad ? ad.isSupportedPage() : null, hint: ad ? ad.pageHint() : null };
    })()
  `);
  record('C3. B站：隔离世界中平台识别为 bilibili', biliIso.injected && biliIso.platform === 'bilibili', JSON.stringify(biliIso).slice(0, 200));
  record('C4. B站：未登录 → isSupportedPage=false + 引导登录', biliIso.supported === false && /登录/.test(biliIso.hint || ''), (biliIso.hint || '').slice(0, 120));

  // C5. B站未登录点抓取 → 面板内报错不崩溃（真实 fetchFollowing 路径）
  const biliErr = await bili.evaluate(`
    (async () => {
      document.getElementById('aiuf-ball').click();
      await new Promise(r => setTimeout(r, 300));
      const btn = document.getElementById('aiuf-fetch');
      if (!btn) return { btn: false };
      btn.click();
      await new Promise(r => setTimeout(r, 2500));
      const body = (document.querySelector('.aiuf-body') || {}).innerText || '';
      return { btn: true, hasError: /抓取失败|未登录/.test(body), body: body.slice(0, 220) };
    })()
  `);
  record('C5. B站：未登录抓取 → 面板内报错不崩溃', biliErr.btn && biliErr.hasError, (biliErr.body || '').replace(/\n/g, ' | '));

  // ---------- D. 面板状态机全流程（隔离世界 patch，安全无写操作） ----------
  // patch fetchFollowing 返回伪造账号 → 抓取 → AI 分类（真实 SW → mock）→ 勾选 → 确认
  // 未登录环境下 unfollow 必定返回「缺少 bili_jct」，验证执行循环的失败处理。
  const patch = await bili.evalInIsolatedWorld(`
    (() => {
      const ad = window.AIUnfollow.getAdapter('bilibili');
      ad.fetchFollowing = async ({ onProgress } = {}) => {
        if (onProgress) onProgress({ phase: 'fetch', done: 6, total: 6 });
        return ${JSON.stringify(MOCK_ACCOUNTS)}.map(a => ({ ...a, avatar: '' }));
      };
      return { patched: true };
    })()
  `);
  record('D1. 隔离世界 patch fetchFollowing（伪造 6 个账号）', patch.patched === true);

  const flowFetch = await bili.evaluate(`
    (async () => {
      // 回到 idle：点「重新抓取」不可见时直接再点抓取按钮（idle 态）
      let btn = document.getElementById('aiuf-fetch');
      if (!btn) return { btn: false };
      btn.click();
      // 等待进入 reviewing（分组标题出现）
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (document.querySelector('.aiuf-cat-head')) break;
      }
      const body = (document.querySelector('.aiuf-body') || {}).innerText || '';
      return { btn: true, reviewing: !!document.querySelector('.aiuf-cat-head'), body: body.slice(0, 300) };
    })()
  `);
  record('D2. 抓取(伪造) → 进入确认页（reviewing）', flowFetch.reviewing, (flowFetch.body || '').replace(/\n/g, ' | ').slice(0, 200));

  const flowCount = await bili.evaluate(`
    (() => {
      const body = (document.querySelector('.aiuf-body') || {}).innerText || '';
      const m = body.match(/共抓到 <b>(\\d+)/) || body.match(/共抓到\\s*(\\d+)/);
      return { total: m ? parseInt(m[1]) : null, selects: document.querySelectorAll('select[data-role="cat"]').length };
    })()
  `);
  record('D3. 确认页渲染 6 个账号（含分类下拉）', flowCount.selects === 6, JSON.stringify(flowCount));

  // AI 分类（走真实 service worker → mock 18923）
  const flowAi = await bili.evaluate(`
    (async () => {
      const run = document.getElementById('aiuf-ai-run');
      if (!run) return { btn: false };
      run.click();
      // 等 AI 完成（按钮恢复可用）
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 500));
        const b = document.getElementById('aiuf-ai-run');
        if (b && !b.disabled) break;
      }
      const body = (document.querySelector('.aiuf-body') || {}).innerText || '';
      return { btn: true, body: body.slice(0, 400) };
    })()
  `);
  const aiGroups = ['常看博主', '营销号', '僵尸号'].filter(c => (flowAi.body || '').includes(c));
  const aiOk = flowAi.btn && aiGroups.length >= 3 && !/未分类（\d+ 人）/.test(flowAi.body || '');
  record('D4. AI 分类完成（真实 SW→mock），三组分类出现', aiOk, '分组: ' + aiGroups.join(',') + ' | ' + (flowAi.body || '').replace(/\n/g, ' | ').slice(0, 160));

  // 勾选 营销号 组全选
  const flowCheck = await bili.evaluate(`
    (() => {
      const heads = [...document.querySelectorAll('.aiuf-cat-head')];
      const h = heads.find(x => x.querySelector('span').textContent.includes('营销号'));
      if (!h) return { found: false };
      h.querySelector('a[data-act="check"]').click();
      const body = (document.querySelector('.aiuf-body') || {}).innerText || '';
      const m = body.match(/已勾选\\s*(\\d+)/);
      return { found: true, selected: m ? parseInt(m[1]) : null, confirmDisabled: document.getElementById('aiuf-confirm')?.disabled };
    })()
  `);
  record('D5. 营销号组全选 → 待取关计数更新', flowCheck.found && flowCheck.selected >= 1 && flowCheck.confirmDisabled === false, JSON.stringify(flowCheck));

  // 确认执行（未登录 → 全部失败，安全）
  const flowExec = await bili.evaluate(`
    (async () => {
      const btn = document.getElementById('aiuf-confirm');
      if (!btn || btn.disabled) return { clicked: false };
      btn.click();
      // 等待 done（结果统计出现）
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 500));
        const body = (document.querySelector('.aiuf-body') || {}).innerText || '';
        if (/执行结束|成功\\s*0|失败\\s*\\d+|再抓一轮/.test(body)) break;
      }
      const body = (document.querySelector('.aiuf-body') || {}).innerText || '';
      return { clicked: true, body: body.slice(0, 400) };
    })()
  `);
  const execOk = flowExec.clicked && /成功/.test(flowExec.body || '') && /失败/.test(flowExec.body || '');
  record('D6. 确认执行 → 状态机走完（未登录全部安全失败）', execOk, (flowExec.body || '').replace(/\n/g, ' | ').slice(0, 200));
  const biliErrs2 = await bili.collectErrors('bilibili');
  const fatal = biliErrs2.filter(e => !/Failed to fetch|csrf|bili_jct|登录/.test(e));
  record('D7. B站页面无致命异常（除预期的未登录错误）', fatal.length === 0, biliErrs2.slice(0, 3).join(' | '));
  bili.close();

  // C6. 抖音主站（隔离世界：真实扩展内容脚本所在上下文）
  const dy = await newPage('https://www.douyin.com/', { settle: 6000 });
  const dyState = await dy.evalInIsolatedWorld(`
    (() => {
      const root = document.getElementById('aiuf-root');
      const act = window.AIUnfollow ? window.AIUnfollow.activeAdapter() : null;
      return { injected: !!root, platform: act && act.name,
        needsRedirect: act && act.adapter.needsRedirect ? act.adapter.needsRedirect() : null,
        hint: act ? act.adapter.pageHint() : null };
    })()
  `);
  record('C6. 抖音主站：内容脚本注入 + 平台识别', dyState.injected && dyState.platform === 'douyin', JSON.stringify(dyState).slice(0, 200));
  record('C7. 抖音主站：提示跳转创作者平台', dyState.needsRedirect === true && /创作者/.test(dyState.hint || ''), (dyState.hint || '').slice(0, 120));

  // C8. 主世界覆盖不了隔离世界的 confirm（原生对话框），改用 CDP 对话框事件断言
  await dy.evaluate(`(() => { const b = document.getElementById('aiuf-ball'); if (b) b.click(); return !!b; })()`);
  await sleep(500);
  const clickFetch = dy.evaluate(`(() => { const b = document.getElementById('aiuf-fetch'); if (b) b.click(); return !!b; })()`);
  const dlg = await dy.waitEvent('Page.javascriptDialogOpening', 20000);
  if (dlg) await dy.send('Page.handleJavaScriptDialog', { accept: false });
  await clickFetch.catch(() => {});
  record('C8. 抖音主站：抓取弹出原生确认框（文案含创作者平台）', !!dlg && /创作者平台/.test(dlg.params?.message || ''), (dlg?.params?.message || '').slice(0, 120));
  dy.close();

  // C9. 抖音创作者平台（登录墙外仅验证注入与面板）
  const creator = await newPage('https://creator.douyin.com/creator-micro/data/following/following', { settle: 6000 });
  const crState = await creator.evalInIsolatedWorld(`
    (() => {
      const root = document.getElementById('aiuf-root');
      const act = window.AIUnfollow ? window.AIUnfollow.activeAdapter() : null;
      return { injected: !!root, platform: act && act.name,
        supported: act ? act.adapter.isSupportedPage() : null,
        hint: act ? act.adapter.pageHint() : null, path: location.pathname };
    })()
  `);
  record('C9. 抖音创作者平台：内容脚本注入 + 面板挂载', crState.injected && crState.platform === 'douyin' && /following/.test(crState.path || ''), JSON.stringify(crState).slice(0, 200));
  record('C10. 抖音创作者平台：未登录提示扫码登录', crState.supported === false || /扫码|登录/.test(crState.hint || ''), (crState.hint || '').slice(0, 120));
  creator.close();

} catch (e) {
  record('测试执行异常中断', false, e.stack || e.message);
}

fs.writeFileSync(new URL('./full-test-result.json', import.meta.url), JSON.stringify(OUT, null, 2));
const pass = OUT.results.filter(r => r.ok).length;
console.log(`\n==== ${pass}/${OUT.results.length} passed ====`);
process.exit(0);
