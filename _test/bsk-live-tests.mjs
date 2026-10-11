// ============================================================
// BrowserSkill 登录态实测（实例 0edd5e34，会话 qdlt）
// ★ 安全约束：全程只读 —— 只点「抓取」「AI 分类」「全选/取消」「搜索」，
//   绝不点击「确认并取关」，不执行任何真实取关。
// 用法：node bsk-live-tests.mjs qdlt
// ============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SESSION = process.argv[2] || 'qdlt';
const BSK = String.raw`C:\Users\35796\.local\bin\bsk.exe`;
const SHOTS = path.join(import.meta.dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const OUT = { results: [], session: SESSION, time: new Date().toISOString() };
function record(name, ok, detail = '') {
  OUT.results.push({ name, ok, detail: String(detail).slice(0, 500) });
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

async function evalJS(expr, { timeoutMs = 60000, retries = 2 } = {}) {
  let lastErr = '';
  for (let i = 0; i <= retries; i++) {
    const r = bsk(['evaluate', '--session', SESSION, '--json', expr], { timeoutMs });
    if (r.json && r.json.ok === true) return r.json.value;
    lastErr = (r.json ? JSON.stringify(r.json) : (r.stderr || r.stdout)).slice(0, 200);
    await sleep(1500);
  }
  throw new Error('evaluate failed: ' + lastErr);
}

async function navigate(url) {
  // 导航超时时页面可能实际已加载成功（重页面 RPC 等待超时），不视为致命错误
  const r = bsk(['navigate', url, '--session', SESSION, '--json'], { timeoutMs: 90000 });
  await sleep(6000);
  if (!(r.json && r.json.tab_id) && r.stderr) {
    console.log(`  (navigate 提示: ${r.stderr.replace(/\s+/g, ' ').slice(0, 80)}，继续用 evaluate 验证)`);
  }
  return r.json || {};
}

async function screenshot(name) {
  const out = path.join(SHOTS, name + '.png').replace(/\\/g, '/');
  for (let i = 0; i < 2; i++) {
    const r = bsk(['screenshot', '--session', SESSION, '--out', out, '--json'], { timeoutMs: 40000 });
    // 成功时返回的对象没有 ok 字段，以 path + 文件存在为准
    if (r.json && r.json.path && fs.existsSync(r.json.path)) return r.json.path;
    await sleep(2000);
  }
  return null;
}

// 打开面板并返回当前 body 文本
async function openPanel() {
  return evalJS(`(() => {
    const ball = document.getElementById('aiuf-ball');
    if (!ball) return { ball: false };
    ball.click();
    return new Promise(r => setTimeout(() => {
      const body = (document.querySelector('.aiuf-body') || {}).innerText || '';
      r({ ball: true, opened: !!document.querySelector('.aiuf-panel'), body: body.slice(0, 300) });
    }, 400));
  })()`, { timeoutMs: 30000 });
}

// ============================================================
try {
  // ---------- B站（用户实际关注列表页） ----------
  await navigate('https://space.bilibili.com/3494379996055918/relation/follow');

  const root = await evalJS(`(() => ({
    root: !!document.getElementById('aiuf-root'), ball: !!document.getElementById('aiuf-ball'),
  }))()`);
  record('L1 B站：插件已加载（悬浮球/root 存在）', root.root && root.ball, JSON.stringify(root));

  // 新版 UI：悬浮球（面板收起时才存在于 DOM）
  const ballUi = await evalJS(`(() => {
    const ball = document.getElementById('aiuf-ball');
    const cs = ball ? getComputedStyle(ball) : null;
    return { gradient: cs ? cs.backgroundImage.includes('gradient') : false, radius: cs ? cs.borderRadius : null };
  })()`);

  const idle = await openPanel();
  record('L2 B站：面板可打开', idle.opened === true, (idle.body || '').slice(0, 120));

  const ui = await evalJS(`(() => {
    const panel = document.querySelector('.aiuf-panel');
    const cs = panel ? getComputedStyle(panel) : null;
    return {
      radius: cs ? cs.borderRadius : null,
      logVisible: !!document.querySelector('.aiuf-log'),
      logwrap: !!document.querySelector('.aiuf-logwrap'),
      hint: (document.querySelector('.aiuf-hint') || {}).innerText || '',
    };
  })()`);
  record('L3 新版 UI 生效（大圆角 + 渐变球）', ui.radius === '16px' && ballUi.gradient === true, JSON.stringify({ ...ui, ball: ballUi }).slice(0, 180));
  record('L4 默认无裸露日志框（idle 态）', ui.logVisible === false && ui.logwrap === false);
  const loggedIn = !/登录/.test(ui.hint || '');
  record('L5 登录态识别', loggedIn === true ? true : true, (ui.hint || '').slice(0, 140)); // 信息项，不判成败
  if (!loggedIn) {
    console.log('\n⚠️  B站未登录：请在该浏览器中登录 bilibili.com 后重跑本脚本（会停在抓取前的报错路径）');
  }

  let fetched = { ok: false };
  if (loggedIn) {
    // 真实抓取（只读 GET API）
    await evalJS(`(() => { const b = document.getElementById('aiuf-fetch'); if (b) b.click(); return !!b; })()`);
    // 等待进入 reviewing（最多 90s）
    let reviewing = false, bodyTxt = '';
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      const st = await evalJS(`(() => ({
        reviewing: !!document.querySelector('.aiuf-cat-head'),
        body: ((document.querySelector('.aiuf-body') || {}).innerText || '').slice(0, 260),
        err: (document.querySelector('.aiuf-err') || {}).innerText || '',
      }))()`, { retries: 0 }).catch(() => null);
      if (!st) continue;
      bodyTxt = st.body || '';
      if (st.reviewing || /抓取失败|未登录/.test(bodyTxt + (st.err || ''))) { reviewing = st.reviewing; break; }
    }
    const acctCount = reviewing ? await evalJS(`document.querySelectorAll('.aiuf-acct').length`) : 0;
    record('L6 真实抓取：进入分类确认页', reviewing === true, bodyTxt.replace(/\n/g, ' | ').slice(0, 180));
    record('L7 真实抓取：账号渲染数量 > 0', acctCount > 0, `共 ${acctCount} 个账号 DOM`);

    const shot1 = await screenshot('live-bilibili-reviewing');
    record('L8 截图：确认页（新版 UI）', !!shot1, shot1 || 'screenshot failed');

    // 分组操作 + 搜索（纯 UI，不点确认）
    if (reviewing) {
      const ops = await evalJS(`(() => {
        const before = document.querySelectorAll('.aiuf-acct input:checked').length;
        const links = [...document.querySelectorAll('.aiuf-cat-head .ops a')];
        const checkAll = links.find(a => a.dataset.act === 'check');
        if (checkAll) checkAll.click();
        const afterCheck = document.querySelectorAll('.aiuf-acct input:checked').length;
        const filter = document.getElementById('aiuf-filter');
        if (filter) { filter.value = 'a'; filter.dispatchEvent(new Event('input', { bubbles: true })); }
        return new Promise(r => setTimeout(() => {
          const filtered = document.querySelectorAll('.aiuf-acct').length;
          const uncheck = [...document.querySelectorAll('.aiuf-cat-head .ops a')].find(a => a.dataset.act === 'uncheck');
          if (uncheck) uncheck.click();
          const afterUncheck = document.querySelectorAll('.aiuf-acct input:checked').length;
          r({ before, afterCheck, filtered, afterUncheck });
        }, 400));
      })()`);
      record('L9 分组全选/取消 + 昵称搜索可用', ops.afterCheck > ops.before && ops.afterUncheck === 0 && ops.filtered > 0, JSON.stringify(ops));

      // AI 分类（该 profile 未配置接口 → 应优雅报错；若已配置真实接口，发送的是用户自己配置的端点）
      const aiBtn = await evalJS(`(() => { const b = document.getElementById('aiuf-ai-run'); if (b && !b.disabled) b.click(); return !!(b && !b.disabled); })()`);
      let aiState = null;
      if (aiBtn) {
        for (let i = 0; i < 20; i++) {
          await sleep(2000);
          aiState = await evalJS(`(() => ({
            running: document.getElementById('aiuf-ai-run')?.disabled === true,
            err: (document.querySelector('.aiuf-err') || {}).innerText || '',
            body: ((document.querySelector('.aiuf-body') || {}).innerText || '').slice(0, 200),
          }))()`, { retries: 0 }).catch(() => null);
          if (!aiState) continue;
          if (!aiState.running) break;
        }
        const graceful = aiState && (/配置|失败|错误|接口/.test(aiState.err) || !aiState.err); // 未配置→报错；已配置→正常跑完
        record('L10 AI 分类路径执行（错误可优雅展示）', graceful === true, (aiState?.err || aiState?.body || '').replace(/\n/g, ' | ').slice(0, 160));
      } else {
        record('L10 AI 分类路径执行（错误可优雅展示）', false, 'AI 按钮不可用');
      }

      // 确认「确认按钮存在但未被点击」
      const confirmState = await evalJS(`(() => {
        const c = document.getElementById('aiuf-confirm');
        return { exists: !!c, disabled: c ? c.disabled : null };
      })()`);
      record('L11 安全约束：确认按钮存在且未被执行', confirmState.exists === true, JSON.stringify(confirmState) + '（脚本不会点击它）');
    }
  } else {
    const errFlow = await evalJS(`(async () => {
      const b = document.getElementById('aiuf-fetch');
      if (!b) return { btn: false };
      b.click();
      await new Promise(r => setTimeout(r, 3000));
      const body = (document.querySelector('.aiuf-body') || {}).innerText || '';
      return { btn: true, body: body.slice(0, 220), hasError: /抓取失败|未登录/.test(body) };
    })()`);
    record('L6 未登录抓取：面板内优雅报错不崩溃', errFlow.btn && errFlow.hasError, (errFlow.body || '').replace(/\n/g, ' | ').slice(0, 160));
    const shotErr = await screenshot('live-bilibili-notlogin');
    record('L8 截图：未登录错误态', !!shotErr, shotErr || 'screenshot failed');
  }

  // 收起面板，保持页面整洁
  await evalJS(`(() => { const c = document.getElementById('aiuf-close'); if (c) c.click(); return true; })()`).catch(() => {});

  // ---------- 抖音主站（只读：不点抓取，避免原生 confirm 阻塞） ----------
  await navigate('https://www.douyin.com/');
  const dyRoot = await evalJS(`(() => ({ root: !!document.getElementById('aiuf-root') }))()`).catch(() => ({ root: false }));
  record('L12 抖音主站：插件内容脚本注入', dyRoot.root === true);
  const dyPanel = await openPanel().catch(() => ({ opened: false, body: '' }));
  record('L13 抖音主站：面板打开 + 提示跳转创作者平台', dyPanel.opened === true && /创作者/.test(dyPanel.body || ''), (dyPanel.body || '').slice(0, 140));
  await evalJS(`(() => { const c = document.getElementById('aiuf-close'); if (c) c.click(); return true; })()`).catch(() => {});
  const shot2 = await screenshot('live-douyin-main');
  record('L14 截图：抖音主站提示态', !!shot2, shot2 || 'screenshot failed');

  // ---------- 抖音创作者平台（真实抓取，只读） ----------
  await navigate('https://creator.douyin.com/creator-micro/data/following/following');
  const cr = await evalJS(`(() => ({
    root: !!document.getElementById('aiuf-root'),
    path: location.pathname,
    body: (() => { const b = document.getElementById('aiuf-ball'); if (b) b.click(); return ((document.querySelector('.aiuf-body') || {}).innerText || ''); })(),
  }))()`).catch(() => null);
  if (cr) {
    record('L15 创作者平台：注入 + 面板打开', cr.root === true, cr.body.slice(0, 140));
    const crLogged = !/扫码|登录/.test(cr.body || '');
    record('L16 创作者平台：登录态识别（信息项）', true, '以抓取结果为准');

    // 真实抓取（只读：自动滚动读表格；绝不点确认）；未登录时面板会给出明确报错
    {
      await evalJS(`(() => { const b = document.getElementById('aiuf-fetch'); if (b) b.click(); return !!b; })()`);
      let reviewing = false, bodyTxt = '';
      for (let i = 0; i < 90; i++) {
        await sleep(2000);
        const st = await evalJS(`(() => ({
          reviewing: !!document.querySelector('.aiuf-cat-head'),
          body: ((document.querySelector('.aiuf-body') || {}).innerText || '').slice(0, 260),
          err: (document.querySelector('.aiuf-err') || {}).innerText || '',
        }))()`, { retries: 0 }).catch(() => null);
        if (!st) continue;
        bodyTxt = st.body || '';
        if (st.reviewing || /抓取失败|未登录|超时|重试/.test(bodyTxt + (st.err || ''))) { reviewing = st.reviewing; break; }
      }
      const dyCount = reviewing ? await evalJS(`document.querySelectorAll('.aiuf-acct').length`) : 0;
      record('L18 抖音真实抓取：进入分类确认页', reviewing === true, bodyTxt.replace(/\n/g, ' | ').slice(0, 180));
      record('L19 抖音真实抓取：账号渲染数量 > 0', dyCount > 0, `共 ${dyCount} 个账号 DOM`);
      const shot4 = await screenshot('live-douyin-reviewing');
      record('L20 截图：抖音确认页（真实数据）', !!shot4, shot4 || 'screenshot failed');
    }
    // 收起面板
    await evalJS(`(() => { const c = document.getElementById('aiuf-close'); if (c) c.click(); return true; })()`).catch(() => {});
  } else {
    record('L15 创作者平台：注入 + 面板打开', false, '页面加载或求值失败');
  }

} catch (e) {
  record('L0 测试执行异常中断', false, e.message);
}

fs.writeFileSync(path.join(import.meta.dirname, 'bsk-live-result.json'), JSON.stringify(OUT, null, 2));
const p = OUT.results.filter(r => r.ok).length;
console.log(`\n==== ${p}/${OUT.results.length} passed ====`);
process.exit(0);
