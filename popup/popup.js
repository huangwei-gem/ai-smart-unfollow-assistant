// 插件弹窗：设置读写 + 接口连通性测试
const $ = (id) => document.getElementById(id);

function showMsg(kind, text) {
  const el = $('msg');
  el.className = 'msg ' + kind;
  el.textContent = text;
}

async function load() {
  const s = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  $('baseUrl').value = s.baseUrl || '';
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model || '';
  $('batchSize').value = s.batchSize || 40;
}

async function save() {
  const settings = {
    baseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    batchSize: Math.max(5, Math.min(100, parseInt($('batchSize').value, 10) || 40)),
    temperature: 0.2,
  };
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    showMsg('err', '请填写完整的接口地址、API Key 和模型名。');
    return;
  }
  const r = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  if (r && r.ok) {
    showMsg('ok', '已保存 ✓');
    // 通知所有平台页面的面板：接口已切换（面板会显示提示，不做破坏性操作）
    try {
      const tabs = await chrome.tabs.query({});
      tabs.forEach((t) => { try { chrome.tabs.sendMessage(t.id, { type: 'AIUF_ENDPOINT_CHANGED' }).catch(() => {}); } catch (_) {} });
    } catch (_) {}
  }
  else showMsg('err', '保存失败：' + ((r && r.error) || '未知错误'));
}

async function test() {
  const btn = $('test');
  btn.disabled = true;
  btn.textContent = '测试中…';
  // 先保存再测试，保证测的是当前表单值
  const settings = {
    baseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    batchSize: Math.max(5, Math.min(100, parseInt($('batchSize').value, 10) || 40)),
    temperature: 0.2,
  };
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    showMsg('err', '请先填写完整的接口地址、API Key 和模型名。');
    btn.disabled = false;
    btn.textContent = '测试接口连通性';
    return;
  }
  const r = await chrome.runtime.sendMessage({
    type: 'AI_CHAT',
    payload: {
      messages: [{ role: 'user', content: '回复"OK"两个字，不要其它内容。' }],
      temperature: 0,
    },
  });
  btn.disabled = false;
  btn.textContent = '测试接口连通性';
  if (r && r.ok) showMsg('ok', '连通成功 ✓ 模型返回：' + (r.content || '').slice(0, 50));
  else showMsg('err', '失败：' + ((r && r.error) || '未知错误'));
}

// 接口权限诊断 + 一键修复：CORS 报错（preflight 失败）多半是网站访问权限被关
async function checkPerms() {
  const box = $('permBox');
  const state = $('permState');
  const btn = $('fixPerm');
  try {
    const origins = chrome.runtime.getManifest().host_permissions || [];
    const all = await chrome.permissions.getAll();
    const granted = new Set(all.origins || []);
    const missing = origins.filter((o) => !granted.has(o));
    if (!missing.length) {
      box.className = 'perm';
      state.textContent = '✓ 全部 AI 接口域名已授权，可正常请求';
      btn.style.display = 'none';
      return;
    }
    box.className = 'perm bad';
    state.textContent = `⚠ 缺少 ${missing.length} 个域名授权（会导致 CORS 报错），点下方按钮修复`;
    btn.style.display = 'block';
    btn.onclick = async () => {
      const ok = await chrome.permissions.request({ origins: missing });
      if (ok) {
        showMsg('ok', '权限已修复 ✓ 请重新执行 AI 操作。');
        await checkPerms();
      } else {
        showMsg('err', '授权未完成：请在弹出的确认框中点「允许」。');
      }
    };
  } catch (e) {
    box.className = 'perm bad';
    state.textContent = '权限检查失败：' + (e && e.message || e);
    btn.style.display = 'none';
  }
}
checkPerms();

// 接口预设：选中后一键填入地址 / 模型 / Key（开箱即用）
$('preset').onchange = () => {
  const v = $('preset').value;
  if (!v) return;
  const [, base, model, key] = v.split('|');
  $('baseUrl').value = base;
  $('model').value = model;
  $('apiKey').value = key;
  showMsg('ok', '已填入预设，点「保存设置」即可生效。');
};

$('save').onclick = save;
$('test').onclick = test;
// 打开悬浮面板：需要当前活动标签页是平台页面
$('openPanel').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/bilibili\.com|douyin\.com/.test(tab.url || '')) {
    showMsg('err', '请先切换到抖音或 B站 的标签页，再点这个按钮。');
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'OPEN_PANEL' }, () => {
    if (chrome.runtime.lastError) {
      showMsg('err', '无法连接页面脚本：请先刷新平台页面再试。');
    } else {
      window.close();
    }
  });
};

// 清空 AI 缓存：删除所有 aiuf_cache_* 键（分类/领域/筛选结果缓存）
$('clearCache').onclick = async () => {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('aiuf_cache_'));
    await chrome.storage.local.remove(keys);
    showMsg('ok', `已清空 AI 缓存（${keys.length} 类）。下次运行将重新识别全部账号。`);
  } catch (e) {
    showMsg('err', '清空缓存失败：' + (e && e.message || e));
  }
};

load();
