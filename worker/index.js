/* =========================================================================
   Allez ! 的 API 代理（可选）
   -------------------------------------------------------------------------
   作用：让你自己出一个 API Key，访客不用申请就能用。Key 存在 Cloudflare 的
   环境变量里（加密的），不会出现在前端代码里。

   为什么必须代理而不是把 Key 塞进前端：
     前端里的一切都是公开的。只要打开 DevTools 就能把 Key 抄走，然后刷爆你的额度。
     代理能做三件前端做不到的事：藏 Key、按 IP 限流、封掉超大的请求。

   部署：Cloudflare Workers 免费档（每天 10 万次请求）足够个人项目用。
   ========================================================================= */
export default {
  async fetch(request, env) {
    const cors = {
      'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'POST, OPTIONS, GET',
      'access-control-max-age': '86400'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, upstream: !!env.UPSTREAM_BASE }, 200, cors);
    }
    if (request.method !== 'POST') {
      return json({ error: '只接受 POST' }, 405, cors);
    }
    if (!/^\/v1\/(chat\/completions|messages)$/.test(url.pathname)) {
      return json({ error: '不支持的路径：' + url.pathname }, 404, cors);
    }
    if (!env.UPSTREAM_BASE || !env.UPSTREAM_KEY) {
      return json({ error: '服务端未配置 UPSTREAM_BASE / UPSTREAM_KEY' }, 500, cors);
    }

    /* ---- 按 IP 限流 ---- */
    const ip = request.headers.get('cf-connecting-ip')
      || request.headers.get('x-forwarded-for') || 'unknown';
    const day = new Date().toISOString().slice(0, 10);
    const limit = parseInt(env.DAILY_LIMIT || '30', 10);
    const used = await bump(env, `use:${day}:${ip}`);
    if (used > limit) {
      return json({
        error: `今天的使用次数用完了（上限 ${limit} 次/天）。明天再来，或者到「设置」里填你自己的 Key。`
      }, 429, withCors(cors, { 'retry-after': '3600' }));
    }

    /* ---- 转发 ---- */
    let body;
    try { body = await request.json(); }
    catch (e) { return json({ error: '请求体不是合法 JSON' }, 400, cors); }

    // 硬性压掉 max_tokens：一张扫描页 4000 token 够用，放开就是给别人白嫖
    const cap = parseInt(env.MAX_TOKENS || '4000', 10);
    if (!body.max_tokens || body.max_tokens > cap) body.max_tokens = cap;
    if (body.stream) body.stream = false;

    const upstream = env.UPSTREAM_BASE.replace(/\/$/, '') + url.pathname;
    const isClaude = /\/v1\/messages$/.test(url.pathname);
    const headers = { 'content-type': 'application/json' };
    if (isClaude) {
      headers['x-api-key'] = env.UPSTREAM_KEY;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['authorization'] = 'Bearer ' + env.UPSTREAM_KEY;
    }

    try {
      const r = await fetch(upstream, { method: 'POST', headers, body: JSON.stringify(body) });
      const text = await r.text();
      return new Response(text, {
        status: r.status,
        headers: withCors(cors, { 'content-type': r.headers.get('content-type') || 'application/json' })
      });
    } catch (e) {
      return json({ error: '上游请求失败：' + e.message }, 502, cors);
    }
  }
};

/* ---- 计数：优先用 KV（跨实例准确），没绑定就退化为内存计数（软限制） ---- */
const mem = new Map();
async function bump(env, key) {
  if (env.COUNTERS) {
    const cur = parseInt((await env.COUNTERS.get(key)) || '0', 10) + 1;
    await env.COUNTERS.put(key, String(cur), { expirationTtl: 60 * 60 * 48 });
    return cur;
  }
  const cur = (mem.get(key) || 0) + 1;
  mem.set(key, cur);
  return cur;
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: withCors(headers, { 'content-type': 'application/json' })
  });
}
function withCors(base, extra) {
  const h = Object.assign({}, base);
  Object.keys(extra || {}).forEach(k => { if (extra[k]) h[k] = extra[k]; });
  return h;
}
