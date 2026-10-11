// 用新版领域分组 prompt 对真实账号做严格实测（与插件完全相同的 payload 构建）
import fs from 'fs';

const accs = JSON.parse(fs.readFileSync(new URL('./real-accounts-20.json', import.meta.url), 'utf8'));
const payload = accs.map(a => ({ uid: a.uid, name: a.name, sign: (a.sign || '').slice(0, 200) }));

const DOMAIN_PROMPT = `你是一个社交媒体账号分析助手。下面是用户的关注账号列表（JSON 数组，字段见说明）。
请给每个账号打一个内容领域标签，参考以下类目体系（参考飞瓜数据/新抖的达人分类）：
美食、美妆、穿搭时尚、颜值、剧情段子、搞笑、音乐、舞蹈、游戏、动漫、影视综艺、明星娱乐、三农、汽车、数码科技、知识科普、财经、房产、母婴育儿、教育培训、体育、健身、旅游户外、宠物、情感、职场、家居生活、艺术绘画、Vlog日常、带货直播、新闻资讯、公益正能量。
要求：领域名不超过 6 个字，优先使用上述参考标签（B站 UP主可按 B站分区归类：如鬼畜归搞笑、番剧归动漫）；无法判断时用「其他」。

输出要求：严格输出 JSON 数组，不要输出任何其它文字或 markdown 代码块标记。
格式：[{"uid":"账号uid","category":"领域名"}]
必须覆盖输入列表中的每一个 uid。

账号列表：
`;

const EP = {
  name: 'agnes-2.5-pro-beta',
  url: 'https://apihub.agnes-ai.com/v1/chat/completions',
  key: 'sk-P5tZ5ljBOWyNi85fVzabu633Vp88cmP78d4G7279f6k9KNQj',
  model: 'agnes-2.5-pro-beta',
};

const t0 = Date.now();
const r = await fetch(EP.url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + EP.key },
  body: JSON.stringify({
    model: EP.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: '你是严谨的分类器，只输出要求的 JSON。' },
      { role: 'user', content: DOMAIN_PROMPT + JSON.stringify(payload) },
    ],
  }),
  signal: AbortSignal.timeout(60000),
});
const j = await r.json();
const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
console.log('HTTP', r.status, Math.round((Date.now() - t0) / 1000) + 's');

let parsed = null;
try {
  const s = txt.indexOf('['), e = txt.lastIndexOf(']');
  parsed = JSON.parse(txt.slice(s, e + 1));
} catch (_) {}
if (!Array.isArray(parsed)) { console.log('解析失败:', txt.slice(0, 300)); process.exit(1); }

const nameOf = Object.fromEntries(accs.map(a => [a.uid, a.name]));
const cover = parsed.filter(x => payload.some(a => a.uid === x.uid && x.category));
console.log(`覆盖 ${cover.length}/${payload.length}`);
for (const x of cover) console.log(`  ${x.category}\t${nameOf[x.uid] || x.uid}`);
