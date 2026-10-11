// 本地 Mock OpenAI 兼容服务（带 CORS，供 MV3 service worker 调用）
// 用法：node mock-ai.mjs  → 监听 http://127.0.0.1:18923/v1
import http from 'node:http';

const PORT = 18923;
const TEST_KEY = process.env.TEST_KEY || 'test' + '-key-' + '123';

const server = http.createServer((req, res) => {
  // CORS：允许扩展 service worker 跨源调用
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const auth = req.headers['authorization'] || '';
      if (auth !== 'Bearer ' + TEST_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      // 从请求里解析账号列表，原样返回分类结果
      let accounts = [];
      try {
        const payload = JSON.parse(body);
        const content = payload.messages[payload.messages.length - 1].content;
        const m = content.match(/账号列表：\s*(\[[\s\S]*\])/);
        if (m) accounts = JSON.parse(m[1]);
      } catch (_) {}
      const result = accounts.map((a) => ({
        uid: a.uid,
        // 简单规则让测试可断言：名字含"测试"→营销号，含"官方"→常看博主，否则僵尸号
        category: /测试|推广|营销/.test(a.name || '') ? '营销号'
          : /官方|频道/.test(a.name || '') ? '常看博主' : '僵尸号',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(result) } }],
        usage: { total_tokens: 42 },
      }));
      console.log(`[mock] served ${accounts.length} accounts`);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found: ' + req.url } }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock openai on http://127.0.0.1:${PORT}/v1`));
