/* 自动补中文释义 · 端到端冒烟（node zhfill-smoke.js）
   用 docs/index.html（构建产物）在 jsdom 里跑真实流程：
   粘贴材料 → 解析 → 自动补齐中文 → 表格里出现中文。
   网络那一步用 mock 顶替，同时校验真实请求的 URL 拼得对不对。 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = path.join(__dirname, 'docs', 'index.html');
const TXT = process.argv[2] || path.join(__dirname, 'sample', 'formats', 'src.txt');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + detail : '')); }
}

const seen = [];
let replyMode = 'normal';

function fakeFetch(url) {
  const u = String(url);
  seen.push(u);
  const prompt = decodeURIComponent(u.replace(/^https:\/\/text\.pollinations\.ai\//, '').split('?')[0] || '');
  const n = (prompt.match(/^\s*\d+\.\s/gm) || []).length;
  let body;
  if (replyMode === 'numbered') body = Array.from({ length: n }, (_, i) => `${i + 1}. 义项${i + 1}`).join('\n');
  else if (replyMode === 'quoted') body = Array.from({ length: n }, (_, i) => `"义项${i + 1}"`).join('\n');
  else if (replyMode === 'empty') body = '';
  else if (replyMode === 'html') body = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>error</body></html>';
  else body = Array.from({ length: n }, (_, i) => `义项${i + 1}`).join('\n');
  return Promise.resolve({ ok: body !== '', status: body !== '' ? 200 : 502, text: () => Promise.resolve(body) });
}

(async () => {
  const html = fs.readFileSync(HTML, 'utf8');
  const text = fs.readFileSync(TXT, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://whatwhatman.github.io/allez/',
    beforeParse(w) { w.fetch = fakeFetch; }
  });
  const w = dom.window, d = w.document;
  await new Promise(r => setTimeout(r, 400));

  console.log('[设置栏目]');
  const preset = d.querySelector('#apiPreset');
  ok('服务商下拉存在', !!preset);
  ok('默认选中免费公共 AI', preset && preset.value === 'free', preset && preset.value);
  const msel = d.querySelector('#apiModelSel');
  ok('免费 AI 显示模型下拉', msel && !d.querySelector('#apiModelSelRow').classList.contains('hide'));
  ok('模型下拉有 6 个选项', msel && msel.options.length === 6, msel && msel.options.length);
  ok('Key / Endpoint 两行被隐藏',
    d.querySelector('#apiKeyRow').classList.contains('hide') && d.querySelector('#apiBaseRow').classList.contains('hide'));
  const az = d.querySelector('#autoZh');
  ok('自动补释义开关默认开', az && az.checked);

  console.log('\n[解析 + 自动补齐]');
  d.querySelector('#src').value = text + '\n' + text;    // 凑够长度触发解析
  d.querySelector('#btnAnalyze').click();
  await new Promise(r => setTimeout(r, 2500));

  ok('确实走了免费 AI 接口', seen.length > 0 && seen[0].startsWith('https://text.pollinations.ai/'), seen[0] && seen[0].slice(0, 60));
  ok('请求带上 model 参数', seen.length > 0 && /[?&]model=/.test(seen[0]));
  const prompt0 = decodeURIComponent(seen[0].split('?')[0].replace(/^https:\/\/text\.pollinations\.ai\//, ''));
  ok('提示词里带材料主题', /Domain of the source text/i.test(prompt0), prompt0.slice(0, 80));
  // 指令部分必须是英文：中文 UTF-8 编码后一个字变 9 个字符，URL 会膨胀到超时
  ok('指令部分用英文写', !/[一-龥]/.test(prompt0.slice(0, 200)), prompt0.slice(0, 60));
  ok('每批不超过 8 个词', (prompt0.match(/^\s*\d+\.\s/gm) || []).length <= 8);

  const rows = Array.from(d.querySelectorAll('#vocabTable tbody tr'));
  const withZh = rows.filter(tr => {
    const c = tr.querySelector('td.zh');
    return c && c.textContent && c.textContent.trim() && c.textContent.indexOf('待补') < 0;
  });
  ok('词表有条目', rows.length > 0, rows.length);
  ok('补上了中文释义', withZh.length > 0, withZh.length + '/' + rows.length);
  ok('中文释义内容正确', withZh.length > 0 && /义项/.test(withZh[0].querySelector('td.zh').textContent),
    withZh[0] && withZh[0].querySelector('td.zh').textContent);

  // 换一种模型回复风格（带编号 / 带引号），解析仍要稳
  console.log('\n[回复格式兼容]');
  for (const mode of ['numbered', 'quoted']) {
    replyMode = mode;
    const before = Array.from(d.querySelectorAll('#vocabTable tbody tr td.zh')).filter(c => /义项/.test(c.textContent)).length;
    d.querySelector('#src').value = text + '\n' + text + '\n' + text;
    d.querySelector('#btnAnalyze').click();
    await new Promise(r => setTimeout(r, 2000));
    const now = Array.from(d.querySelectorAll('#vocabTable tbody tr td.zh')).filter(c => /义项\d/.test(c.textContent)).length;
    ok('模型回复带' + (mode === 'numbered' ? '编号' : '引号') + '也能解析', now > 0, now + '（之前 ' + before + '）');
  }

  // 服务不可用时要给得出人话，不能白屏或抛栈
  console.log('\n[失败处理]');
  replyMode = 'empty';
  d.querySelector('#src').value = text + '\n' + text;
  d.querySelector('#btnAnalyze').click();
  await new Promise(r => setTimeout(r, 2000));
  ok('服务出错后界面仍可渲染', !!d.querySelector('#vocabTable'));

  // 关键回归：被限流时常拿到 200 + 一个 HTML 页面，绝不能把 <html> 当成中文写进词表
  console.log('\n[HTML 错误页不能被当成释义]');
  replyMode = 'html';
  d.querySelector('#src').value = text + '\n' + text;
  d.querySelector('#btnAnalyze').click();
  await new Promise(r => setTimeout(r, 2500));
  const cells = Array.from(d.querySelectorAll('#vocabTable tbody tr td.zh')).map(c => c.textContent);
  ok('词表里没有 HTML 残渣', !cells.some(c => /<!DOCTYPE|<html|cloudflare/i.test(c)),
    cells.find(c => /<!DOCTYPE|<html/i.test(c)));
  ok('这些词显示为待补而不是假释义', cells.filter(c => c.trim() === '待补').length > 0,
    cells.slice(0, 3).join(' / '));

  console.log('\n' + (fail ? '✗ ' : 'OK — ') + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exit(1);
})();
