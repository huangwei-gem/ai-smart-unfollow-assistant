import { setTimeout as sleep } from 'node:timers/promises';
const BASE = 'http://127.0.0.1:9222';
const targets = await (await fetch(BASE + '/json/list')).json();
const sw = targets.find(t => t.type === 'service_worker');
const extId = sw.url.match(/chrome-extension:\/\/([^/]+)/)[1];
// 试试直接导航到 manifest.json
const t = await (await fetch(BASE + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json();
await sleep(500);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
const send = (method, params={}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(r => r.result?.value);
await send('Page.enable');
for (const path of ['manifest.json', 'popup/popup.html', 'icons/icon16.png']) {
  await send('Page.navigate', { url: `chrome-extension://${extId}/${path}` });
  await sleep(1200);
  const st = await ev('({href: location.href, body: (document.body && document.body.innerText || "").slice(0,120)})');
  console.log(path, '=>', JSON.stringify(st));
}
process.exit(0);
