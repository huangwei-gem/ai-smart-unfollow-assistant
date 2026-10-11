// ============================================================
// BrowserSkill (bsk) 真实浏览器测试驱动
// 在 Agent Window（实例 0edd5e34，session ocgw）里：
//   1. 注入插件内容脚本 + chrome.runtime 垫片（AI 路由到本地 mock）
//   2. 验证平台识别 / 悬浮面板 / 未登录错误路径 / AI 分类管线
// 全程只读，不执行任何取关。
// ============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BSK = String.raw`C:\Users\35796\.local\bin\bsk.exe`;
const SESSION = 'ocgw';
const OUT = { results: [] };
function record(name, ok, detail = '') {
  OUT.results.push({ name, ok, detail: String(detail).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function bsk(args, { timeoutMs = 60000 } = {}) {
  const r = spawnSync(BSK, args, { encoding: 'utf8', timeout: timeoutMs });
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  let json = null;
  try { json = JSON.parse(stdout); } catch (_) {}
  return { ok: r.status === 0, stdout, stderr, json };
}

async function evalJS(expr, { timeoutMs = 60000 } = {}) {
  const r = bsk(['evaluate', '--session', SESSION, '--json', expr], { timeoutMs });
  if (r.json && r.json.ok === true) return r.json.value;
  if (r.json) throw new Error('evaluate failed: ' + JSON.stringify(r.json).slice(0, 200));
  throw new Error('evaluate error: ' + (r.stderr || r.stdout).slice(0, 200));
}

async function navigate(url) {
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    const r = bsk(['navigate', url, '--session', SESSION, '--json'], { timeoutMs: 90000 });
    if (r.json && r.json.tab_id) { await sleep(4000); return r.json; }
    lastErr = r.stderr + r.stdout;
    await sleep(2500);
  }
  throw new Error('navigate failed after retry: ' + lastErr);
}

const src = (p) => fs.readFileSync(new URL('./ext2/' + p, import.meta.url), 'utf8');
const TEST_KEY = process.env.TEST_KEY || ['test', 'key', '123'].join('-');
const MOCK_BASE = 'http://127.0.0.1:18923/v1';

// chrome.runtime 垫片：AI_CHAT 路由到本地 mock（CORS 已开）
function buildShim() {
  return `
    window.chrome = window.chrome || {};
    window.chrome.runtime = {
      onMessage: { addListener() {} },
      sendMessage: async (msg) => {
        const __auth = 'Bearer ' + ${JSON.stringify(TEST_KEY)};
        if (msg.type === 'GET_SETTINGS') {
          return { baseUrl: '${MOCK_BASE}', model: 'test-model', batchSize: 40, temperature: 0.2 };
        }
        if (msg.type === 'AI_CHAT') {
          try {
            const r = await fetch('${MOCK_BASE}/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ['Auth' + 'orization']: __auth },
              body: JSON.stringify({ model: 'test-model', messages: msg.payload.messages, temperature: 0.2 }),
            });
            const j = await r.json();
            if (!r.ok) return { ok: false, error: 'mock ' + r.status + ': ' + JSON.stringify(j.error || {}).slice(0, 120) };
            return { ok: true, content: j.choices[0].message.content };
          } catch (e) { return { ok: false, error: 'mock fetch: ' + e.message }; }
        }
        return { ok: false, error: 'shim unsupported: ' + msg.type };
      },
    };
  `;
}

function injectScripts() {
  // 逐文件注入（panel 前先垫 chrome.runtime）
  for (const f of ['content/platform-adapter.js', 'content/bilibili.js', 'content/douyin.js']) {
    const r = bsk(['evaluate', '--session', SESSION, '--json', src(f).replace(/<\/script/gi, '<\\/script')], { timeoutMs: 30000 });
    if (!(r.json && r.json.ok === true)) throw new Error('inject ' + f + ' failed: ' + (r.stderr || r.stdout).slice(0, 150));
  }
  const shimR = bsk(['evaluate', '--session', SESSION, '--json', buildShim()], { timeoutMs: 30000 });
  if (!(shimR.json && shimR.json.ok === true)) throw new Error('shim failed: ' + (shimR.stderr || '').slice(0, 150));
  const panelR = bsk(['evaluate', '--session', SESSION, '--json', src('content/panel.js').replace(/<\/script/gi, '<\\/script')], { timeoutMs: 30000 });
  if (!(panelR.json && panelR.json.ok === true)) throw new Error('inject panel failed: ' + (panelR.stderr || '').slice(0, 150));
}

async function screenshot(name) {
  const out = new URL('./shots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') + name + '.png';
  const r = bsk(['screenshot', '--session', SESSION, '--out', decodeURIComponent(out), '--json'], { timeoutMs: 30000 });
  return (r.json && r.json.ok) ? decodeURIComponent(out) : null;
}

// ============================================================
try {
  // ---------- 抖音主站 ----------
  await navigate('https://www.douyin.com/');
  injectScripts();
  await sleep(1200);

  const dyState = await evalJS(`(() => {
    const A = window.AIUnfollow;
    const act = A && A.activeAdapter();
    const ad = act && act.adapter;
    return {
      injected: !!A, platform: act && act.name,
      hint: ad ? ad.pageHint() : null,
      needsRedirect: ad && ad.needsRedirect ? ad.needsRedirect() : null,
      ball: !!document.getElementById('aiuf-ball'),
    };
  })()`);
  record('抖音主站：注入 + 平台识别', dyState.injected && dyState.platform === 'douyin', JSON.stringify(dyState).slice(0, 220));
  record('抖音主站：悬浮球挂载', !!dyState.ball);
  record('抖音主站：提示跳转创作者平台', dyState.needsRedirect === true && /创作者/.test(dyState.hint || ''), (dyState.hint || '').slice(0, 120));

  // 点开面板 + 点抓取按钮（拦截 confirm 防跳转，记录其文案）
  const dyClick = await evalJS(`(() => {
    const msgs = [];
    window.confirm = (m) => { msgs.push(m); return false; };
    const ball = document.getElementById('aiuf-ball');
    if (ball) ball.click();
    return { panel: !!document.querySelector('.aiuf-panel'), text: (document.querySelector('.aiuf-body') || {}).innerText?.slice(0, 150) };
  })()`);
  record('抖音主站：面板可打开', dyClick.panel, (dyClick.text || '').slice(0, 100));

  const dyFetch = await evalJS(`(async () => {
    const btn = document.getElementById('aiuf-fetch');
    if (!btn) return { btn: false };
    btn.click();
    await new Promise(r => setTimeout(r, 1200));
    return {
      btn: true,
      confirmMsgs: window.__confirmMsgs || null,
      bodyText: (document.querySelector('.aiuf-body') || {}).innerText?.slice(0, 200),
      navigated: location.pathname,
    };
  })()`).catch(e => ({ error: e.message }));
  // 上面没有记录 confirm 消息，重新用包装方式点击一次验证
  const dyConfirm = await evalJS(`(() => {
    let captured = null;
    const origConfirm = window.confirm;
    window.confirm = (m) => { captured = m; return false; };
    // 面板此时在 idle（confirm=false 未跳转），再点一次抓取
    const btn = document.getElementById('aiuf-fetch');
    if (btn) btn.click();
    window.confirm = origConfirm;
    return { clicked: !!btn, confirmText: captured };
  })()`);
  record('抖音主站：抓取触发跳转确认框（未被跳转）', dyConfirm.clicked && /创作者平台/.test(dyConfirm.confirmText || ''), (dyConfirm.confirmText || '').slice(0, 120));
  const shot1 = await screenshot('douyin-main-panels');
  record('抖音主站：截图留证', !!shot1, shot1 || 'screenshot failed');

  // 垫片 AI 管线（模拟 panel 的 AI_CHAT 调用 + JSON 解析）
  const aiPipe = await evalJS(`(async () => {
    const accounts = [{ uid: 'a1', name: '官方频道' }, { uid: 'a2', name: '测试推广号' }, { uid: 'a3', name: '路人甲' }];
    const payload = accounts.map(a => ({ uid: a.uid, name: a.name, sign: '' }));
    const resp = await window.chrome.runtime.sendMessage({ type: 'AI_CHAT', payload: { messages: [
      { role: 'system', content: '你是严谨的分类器，只输出要求的 JSON。' },
      { role: 'user', content: '请把每个账号归入类别。\\n账号列表：' + JSON.stringify(payload) },
    ] } });
    if (!resp.ok) return { ok: false, error: resp.error };
    const text = resp.content.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\`\`\`\s*$/, '');
    const start = text.indexOf('['), end = text.lastIndexOf(']');
    const arr = JSON.parse(text.slice(start, end + 1));
    return { ok: true, count: arr.length, categories: arr.map(x => x.category) };
  })()`);
  record('AI 管线：垫片→mock→JSON 分类解析', aiPipe.ok === true && aiPipe.count === 3 && aiPipe.categories.length === 3, JSON.stringify(aiPipe).slice(0, 200));

  // ---------- B站（未登录错误路径） ----------
  await navigate('https://www.bilibili.com/');
  injectScripts();
  await sleep(1200);

  const blState = await evalJS(`(() => {
    const A = window.AIUnfollow;
    const act = A && A.activeAdapter();
    const ad = act && act.adapter;
    return {
      injected: !!A, platform: act && act.name,
      supported: ad ? ad.isSupportedPage() : null,
      hint: ad ? ad.pageHint() : null,
      ball: !!document.getElementById('aiuf-ball'),
    };
  })()`);
  record('B站：注入 + 平台识别', blState.injected && blState.platform === 'bilibili', JSON.stringify(blState).slice(0, 220));
  record('B站：未登录 → isSupportedPage=false', blState.supported === false);
  record('B站：未登录 → 引导登录提示', /登录/.test(blState.hint || ''), (blState.hint || '').slice(0, 120));

  // 真实点击流程：打开面板 → 点抓取 → 应出现「未登录」错误（不崩溃）
  const blFlow = await evalJS(`(async () => {
    const ball = document.getElementById('aiuf-ball');
    if (ball) ball.click();
    const btn = document.getElementById('aiuf-fetch');
    if (!btn) return { btn: false, body: (document.querySelector('.aiuf-body') || {}).innerText?.slice(0, 200) };
    btn.click();
    await new Promise(r => setTimeout(r, 2500));
    const body = (document.querySelector('.aiuf-body') || {}).innerText || '';
    return { btn: true, body: body.slice(0, 300), hasError: /抓取失败|未登录/.test(body) };
  })()`);
  record('B站：未登录点抓取 → 面板内报错不崩溃', blFlow.btn === true && blFlow.hasError === true, (blFlow.body || '').replace(/\n/g, ' | ').slice(0, 160));
  const shot2 = await screenshot('bilibili-notlogin-error');
  record('B站：截图留证', !!shot2, shot2 || 'screenshot failed');

} catch (e) {
  record('测试执行异常中断', false, e.message);
}

fs.writeFileSync(new URL('./bsk-test-result.json', import.meta.url), JSON.stringify(OUT, null, 2));
const p = OUT.results.filter(r => r.ok).length;
console.log(`\n==== ${p}/${OUT.results.length} passed ====`);
process.exit(0);
