import { setTimeout as sleep } from 'node:timers/promises';
const BASE = 'http://127.0.0.1:9225';
async function openTab(url) {
  const t = await (await fetch(BASE + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json();
  await sleep(600);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0; const pend = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  const send = (method, params={}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(r => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  });
  return { send, ev, ws };
}
// 1) chrome://extensions 拿插件信息
const ext = await openTab('chrome://extensions/');
await sleep(1500);
const infos = await ext.ev(`chrome.developerPrivate.getExtensionsInfo().then(l => l.map(i => ({ id: i.id, name: i.name, state: i.state, errors: (i.runtimeErrors||[]).map(e=>e.message).concat((i.manifestErrors||[]).map(e=>e.message)).slice(0,3) })))`);
console.log(JSON.stringify(infos, null, 1));
const mine = infos.find(i => i.name && i.name.includes('取关'));
if (!mine) { console.log('EXT NOT FOUND'); process.exit(1); }
console.log('mine:', mine.id, mine.state);
// 2) 打开弹窗页测试 DOM + 唤醒 SW
const pop = await openTab(`chrome-extension://${mine.id}/popup/popup.html`);
await sleep(1500);
console.log(JSON.stringify(await pop.ev('({href: location.href, hasSave: !!document.getElementById("save"), inputs: document.querySelectorAll("input").length})'), null, 1));
// 3) SW 是否上线
await sleep(1500);
const targets = await (await fetch(BASE + '/json/list')).json();
console.log('targets:', targets.map(t => t.type + ':' + t.url.slice(0, 70)).join(' | '));
process.exit(0);
