/* 把 index.html + style.css + 各个 js 打成单文件 HTML */
const fs = require('fs'), path = require('path');
let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
let js = ['data.js', 'pdftext.js', 'ocr.js', 'engine.js', 'app.js', 'guide.js']
  .map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n;\n');

/* 站主可选部署的共享代理。没给环境变量就不启用（占位符替换成空串）。
   用法：ALLEZ_PROXY_BASE=https://xxx.workers.dev ALLEZ_PROXY_MODEL=glm-4-flash node build.js
   注意 /v1 前缀：前端拼的是 base + '/chat/completions'，而 Worker 只认 /v1/chat/completions。 */
let proxyBase = (process.env.ALLEZ_PROXY_BASE || '').trim().replace(/\/$/, '');
const proxyModel = (process.env.ALLEZ_PROXY_MODEL || '').trim();
if (proxyBase) {
  if (!/^https?:\/\//.test(proxyBase)) throw new Error('ALLEZ_PROXY_BASE 必须是 http(s) 开头的完整地址');
  if (!/\/v1$/.test(proxyBase)) proxyBase += '/v1';
  if (!proxyModel) throw new Error('启用了代理就必须同时给 ALLEZ_PROXY_MODEL');
} else if (proxyModel) {
  throw new Error('给了 ALLEZ_PROXY_MODEL 但没有 ALLEZ_PROXY_BASE');
}
js = js.replace('__ALLEZ_PROXY_BASE__', () => proxyBase)
  .replace('__ALLEZ_PROXY_MODEL__', () => proxyModel);

html = html.replace('<link rel="stylesheet" href="style.css">', () => '<style>\n' + css + '\n</style>');
html = html.replace(/<script src="[^"]+"><\/script>\s*/g, '');
// 必须用函数式 replacer：否则 JS 里的 $$ / $& 会被当成 replace 的转义符
html = html.replace('</body>', () => '<script>\n' + js + '\n</script>\n</body>');

// docs/ 是 GitHub Pages 的发布目录（Pages 设置里选 main 分支 + /docs）
const docs = path.join(__dirname, 'docs');
if (!fs.existsSync(docs)) fs.mkdirSync(docs);
fs.writeFileSync(path.join(docs, 'index.html'), html);
fs.writeFileSync(path.join(__dirname, 'allez-standalone.html'), html);   // 单独分发用的副本
fs.writeFileSync(path.join(docs, '.nojekyll'), '');                      // 别让 Jekyll 吃掉下划线文件
console.log('已生成 docs/index.html：' + (html.length / 1024).toFixed(0) + ' KB');
console.log('共享代理：' + (proxyBase ? '已启用 → ' + proxyBase + '（' + proxyModel + '）' : '未启用（访客需自填 Key）'));
console.log('内联 script 块:', (html.match(/<script>/g) || []).length,
  '| 残留外链:', (html.match(/<script src|<link rel="stylesheet"/g) || []).length,
  '| 占位符残留:', /__ALLEZ_PROXY/.test(html) ? '有 ✗' : '无 ✓',
  '| $$ 完好:', html.includes('const $$ = s => Array.from') ? '是' : '否');
