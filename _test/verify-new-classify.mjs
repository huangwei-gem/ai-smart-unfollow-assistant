// 用新版 5 类主分类 prompt 对真实账号做严格实测
import fs from 'fs';

const accs = JSON.parse(fs.readFileSync(new URL('./real-accounts-20.json', import.meta.url), 'utf8'));
const payload = accs.map(a => ({ uid: a.uid, name: a.name, sign: (a.sign || '').slice(0, 200) }));

const PROMPT_TMPL = `你是一个社交媒体关注列表分析助手。下面是用户关注的部分账号（JSON 数组）。
字段说明：name 昵称；sign 完整简介签名；official=true 表示官方认证号；vip=true 表示大会员（B站，通常为活跃用户）。

判断时请综合参考以下维度（参考蝉妈妈/飞瓜数据等达人分析平台的评估体系）：
【价值信号】内容垂直单一领域；昵称/签名体现真实创作意图（记录/教学/分享）；认证号、大会员通常更活跃。
【营销号/引流信号】签名或昵称藏联系方式（VX/微/谐音字/emoji 变体、「福利群」「看更多」「懂的来」）；带货/广告/招商/课程推销；虚假权威人设（大师/专家/导师）；卖惨博流量。
【擦边信号】性暗示挑逗文字、身材诱惑、软色情诱导话术，表面挂穿搭/舞蹈/摄影实则靠性张力吸粉。
【僵尸号信号】签名为空且昵称无意义、疑似一次性活动号/节日号（关注理由已消失）、纯搬运无原创。
【熟人信号】昵称像真实姓名或日常网名。

请把每个账号归入以下类别之一：
- 常看博主：内容垂直、质量高，用户大概率仍想看的创作者
- 可能认识：疑似现实朋友同事同学（看昵称特征）
- 僵尸号：长期不活跃、无有效内容特征，或简介为空且昵称无意义
- 营销号：广告、带货、推广、引流、微商、虚假人设性质明显
- 不感兴趣：低价值、标题党、擦边低俗、或没有充分理由继续关注的账号

输出要求：严格输出 JSON 数组，不要输出任何其它文字或 markdown 代码块标记。
格式：[{"uid":"账号uid","category":"类别名"}]
必须覆盖输入列表中的每一个 uid，类别名必须使用上面给出的五个类别名之一。

账号列表：
`;

const EP = {
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
      { role: 'user', content: PROMPT_TMPL + JSON.stringify(payload) },
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
