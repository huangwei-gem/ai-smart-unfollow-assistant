# -*- coding: utf-8 -*-
# 用真实 B站关注数据模拟扩展的完整领域分组请求，检查各端点返回的 uid/category 格式
import json, urllib.request, ssl

ctx = ssl.create_default_context()

# 1. 从浏览器页面（cookie 同源限制，改用带 cookie 的请求由 bsk evaluate 完成；这里用公开接口拿 mid 需要登录态）
#    改为：让脚本从 _test/real-accounts-20.json 或命令行读取；这里直接从 bsk 导出的文件读
accounts = json.load(open('_test/bili-accounts.json', encoding='utf-8'))
payload = [{"uid": str(a["uid"]), "name": a["name"], "sign": (a.get("sign") or "")[:200]} for a in accounts]

DOMAIN_PROMPT = """你是一个社交媒体账号分析助手。下面是用户的关注账号列表（JSON 数组，字段见说明）。
请给每个账号打一个内容领域标签，参考以下类目体系（参考飞瓜数据/新抖的达人分类）：
美食、美妆、穿搭时尚、颜值、剧情段子、搞笑、音乐、舞蹈、游戏、动漫、影视综艺、明星娱乐、三农、汽车、数码科技、知识科普、财经、房产、母婴育儿、教育培训、体育、健身、旅游户外、宠物、情感、职场、家居生活、艺术绘画、Vlog日常、带货直播、新闻资讯、公益正能量。
要求：领域名不超过 6 个字，优先使用上述参考标签（B站 UP主可按 B站分区归类：如鬼畜归搞笑、番剧归动漫）；无法判断时用「其他」。

输出要求：严格输出 JSON 数组，不要输出任何其它文字或 markdown 代码块标记。
格式：[{"uid":"账号uid","category":"领域名"}]
必须覆盖输入列表中的每一个 uid。

账号列表：
""" + json.dumps(payload, ensure_ascii=False)

endpoints = [
    ("sensenova-6.8-flash-lite", "https://token.sensenova.cn/v1", "sk-F3WGt9cnsCrduZMyhyTYMEEKYJWE1Mzn"),
    ("z-ai/glm-5.3-flash", "https://integrate.api.nvidia.com/v1", "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"),
    ("glm-5.2", "https://token.sensenova.cn/v1", "sk-F3WGt9cnsCrduZMyhyTYMEEKYJWE1Mzn"),
]

for name, base, key in endpoints:
    print("=" * 20, name)
    body = json.dumps({
        "model": name,
        "messages": [
            {"role": "system", "content": "你是严谨的分类器，只输出要求的 JSON。"},
            {"role": "user", "content": DOMAIN_PROMPT},
        ],
        "temperature": 0.2,
    }, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(base + "/chat/completions", data=body, headers={
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": "Bearer " + key,
    })
    try:
        with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
            j = json.loads(r.read().decode("utf-8"))
        m = j["choices"][0]["message"]
        content = m.get("content") or m.get("reasoning_content") or m.get("reasoning") or ""
        print("CONTENT:", content[:600].replace("\n", " "))
    except Exception as e:
        print("ERROR:", repr(e)[:300])
