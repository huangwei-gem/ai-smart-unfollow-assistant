// ============================================================
// BrowserSkill (bsk) 注入式交叉验证
// 在已连接的浏览器会话里手动注入 content 脚本 + chrome.runtime 垫片
// （AI 路由到本地 mock），验证平台识别 / 面板 / 错误路径 / AI 管线。
// 用法：node bsk-runner.mjs hymo
// ============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SESSION = process.argv[2] || 'hymo';
const BSK = String.raw`C:\Users\35796\.local\bin\bsk.exe`;
const TEST_KEY = 'test-key-123';
const MOCK_BASE = 'http://127.0.0.1:18923/v1';
const SHOTS = path.join(import.meta.dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

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
    if (r.json && r.json.tab_id) { await sleep(5000); return r.json; }
    lastErr = r.stderr + r.stdout;
    await sleep(2500);
  }
  throw new Error('navigate failed after retry: ' + lastErr);
}

const src = (p) => fs.readFileSync(path.join(import.meta.dirname, 'ext2', p), 'utf8');

// chrome.runtime 垫片：AI_CHAT 路由到本地 mock（CORS 已开）
function buildShim() {
  return `
    window.chrome = window.chrome || {};
    window.chrome.runtime = {
      onMessage: { addListener() {} },
      sendMessage: async (msg) => {
        if (msg.type === 'GET_SETTINGS') {
          return { baseUrl: '${MOCK_BASE}', model: 'test-model', batchSize: 40, temperature: 0.2 };
        }
        if (msg.type === 'AI_CHAT') {
          try {
            const r = await fetch('${MOCK_BASE}/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ${TEST_KEY}' },
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
  const out = path.join(SHOTS, name + '.png');
  const r = bsk(['screenshot', '--session', SESSION, '--out', out, '--json'], { timeoutMs: 30000 });
  return (r.json && r.json.ok) ? out : ('screenshot failed: ' + ((r.stderr || r.stdout) || '').slice(0, 120));
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
  record('S1 抖音主站：注入 + 平台识别', dyState.injected && dyState.platform === 'douyin', JSON.stringify(dyState).slice(0, 220));
  record('S2 抖音主站：悬浮球挂载', !!dyState.ball);
  record('S3 抖音主站：提示跳转创作者平台', dyState.needsRedirect === true && /创作者/.test(dyState.hint || ''), (dyState.hint || '').slice(0, 120));

  const dyOpen = await evalJS(`(() => {
    const ball = document.getElementById('aiuf-ball');
    if (ball) ball.click();
    const panel = document.querySelector('.aiuf-panel');
    return { panel: !!panel, text: (panel && panel.innerText || '').slice(0, 150) };
  })()`);
  record('S4 抖音主站：面板可打开', dyOpen.panel, (dyOpen.text || '').slice(0, 100));

  const dyConfirm = await evalJS(`(() => {
    let captured = null;
    const orig = window.confirm;
    window.confirm = (m) => { captured = m; return false; };
    const btn = document.getElementById('aiuf-fetch');
    if (btn) btn.click();
    window.confirm = orig;
    return { clicked: !!btn, confirmText: captured };
  })()`);
  record('S5 抖音主站：抓取触发跳转确认框（未被跳转）', dyConfirm.clicked && /创作者平台/.test(dyConfirm.confirmText || ''), (dyConfirm.confirmText || '').slice(0, 120));

  const shot1 = await screenshot('bsk-douyin-main');
  record('S6 抖音主站：截图留证', !/failed/.test(shot1), shot1);

  // AI 管线（垫片 → mock → JSON 解析，与 panel.js parseAiJson 同路径）
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
  record('S7 AI 管线：垫片→mock→JSON 分类解析', aiPipe.ok === true && aiPipe.count === 3 && aiPipe.categories.length === 3, JSON.stringify(aiPipe).slice(0, 200));

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
  record('S8 B站：注入 + 平台识别', blState.injected && blState.platform === 'bilibili', JSON.stringify(blState).slice(0, 220));
  record('S9 B站：未登录 → isSupportedPage=false', blState.supported === false);
  record('S10 B站：未登录 → 引导登录提示', /登录/.test(blState.hint || ''), (blState.hint || '').slice(0, 120));

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
  record('S11 B站：未登录点抓取 → 面板内报错不崩溃', blFlow.btn === true && blFlow.hasError === true, (blFlow.body || '').replace(/\n/g, ' | ').slice(0, 160));

  const shot2 = await screenshot('bsk-bilibili-notlogin');
  record('S12 B站：截图留证', !/failed/.test(shot2), shot2);

} catch (e) {
  record('S0 测试执行异常中断', false, e.message);
}

fs.writeFileSync(path.join(import.meta.dirname, 'bsk-runner-result.json'), JSON.stringify(OUT, null, 2));
const p = OUT.results.filter(r => r.ok).length;
console.log(`\n==== ${p}/${OUT.results.length} passed ====`);
process.exit(0);
