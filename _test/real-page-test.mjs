// 真实页面·无登录测试：验证内容脚本注入 + 悬浮面板 + 平台识别 + 引导文案
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 9225;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = { results: [] };
function record(name, ok, detail = '') {
  OUT.results.push({ name, ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) this.events.push(msg);
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
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function newPage(url, settle = 4000) {
  const t = await (await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const cdp = await CDP.connect(t.webSocketDebuggerUrl);
  await sleep(settle);
  return cdp;
}

// 读取插件源码（从工作区干净副本 ext2）
import fs from 'node:fs';
const src = (p) => fs.readFileSync(new URL('./ext2/' + p, import.meta.url), 'utf8');

async function injectAndTest(url, platform, checks, settle = 5000) {
  const cdp = await newPage(url, settle);
  // 按插件 content_scripts 顺序手动注入（等价于扩展加载）
  for (const f of ['content/platform-adapter.js', 'content/bilibili.js', 'content/douyin.js', 'content/panel.js']) {
    await cdp.evaluate(src(f).replace(/<\/script/gi, '<\\/script'));
  }
  await sleep(1500);
  const st = await cdp.evaluate(`(() => {
    const A = window.AIUnfollow;
    if (!A) return { injected: false };
    const act = A.activeAdapter();
    const ad = act && act.adapter;
    return {
      injected: true, platform: act && act.name,
      supported: ad ? ad.isSupportedPage() : null,
      hint: ad ? ad.pageHint() : null,
      panel: !!document.getElementById('aiuf-root'),
      ball: !!document.querySelector('.aiuf-ball') || !!document.getElementById('aiuf-ball'),
      panelHtmlLen: (document.getElementById('aiuf-root') || {innerHTML:''}).innerHTML.length,
    };
  })()`);
  record(`${platform}: 脚本注入 + 平台识别`, st.injected && st.platform === platform, JSON.stringify(st).slice(0, 200));
  record(`${platform}: 悬浮球挂载`, !!st.ball);
  if (checks.hint) record(`${platform}: ${checks.hintLabel}`, checks.hint(st.hint), (st.hint || '').slice(0, 120));
  if (checks.supported !== undefined) record(`${platform}: isSupportedPage=${checks.supported}`, st.supported === checks.supported, String(st.supported));
  // 点开面板看渲染
  const openState = await cdp.evaluate(`(() => {
    const ball = document.getElementById('aiuf-ball');
    if (ball) ball.click();
    const panel = document.querySelector('.aiuf-panel');
    return { opened: !!panel, text: (panel && panel.innerText || '').slice(0, 200) };
  })()`);
  record(`${platform}: 面板可打开且有内容`, openState.opened && openState.text.length > 10, openState.text.slice(0, 100));
  cdp.close();
}

try {
  await injectAndTest('https://www.bilibili.com/', 'bilibili', {
    hint: (h) => /登录/.test(h || ''), hintLabel: '未登录引导提示', supported: false,
  });
  await injectAndTest('https://www.douyin.com/', 'douyin', {
    hint: (h) => /创作者/.test(h || ''), hintLabel: '主站→创作者平台引导', supported: true,
  });
} catch (e) {
  record('测试执行异常', false, e.message);
}
fs.writeFileSync(new URL('./real-page-result.json', import.meta.url), JSON.stringify(OUT, null, 2));
const p = OUT.results.filter(r => r.ok).length;
console.log(`\n==== ${p}/${OUT.results.length} passed ====`);
process.exit(0);
