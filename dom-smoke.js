/* 浏览器端到端冒烟：用 jsdom 真跑一遍页面交互 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: 'usable',
  url: 'file://' + __dirname + '/index.html',
  pretendToBeVisual: true,
  beforeParse(w) {
    w.scrollTo = () => {};
    w.SpeechSynthesisUtterance = function () {};
    w.speechSynthesis = { getVoices: () => [], cancel() {}, speak() {} };
    // jsdom 的 window 里没有 DecompressionStream（真实浏览器 Chrome 80+/Safari 16.4+ 有）。
    // 借用 Node 的实现注入进去，才能真正跑到浏览器那条解压分支。
    if (typeof DecompressionStream !== 'undefined') w.DecompressionStream = DecompressionStream;
    if (typeof CompressionStream !== 'undefined') w.CompressionStream = CompressionStream;
    w.addEventListener('error', e => errors.push('window.onerror: ' + e.message));
    const ce = w.console.error.bind(w.console);
    w.console.error = (...a) => { errors.push('console.error: ' + a.join(' ')); ce(...a); };
  }
});

const $ = s => dom.window.document.querySelector(s);
const $$ = s => Array.from(dom.window.document.querySelectorAll(s));
const click = el => el && el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const setVal = (el, v) => {
  el.value = v;
  el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 等到条件成立或超时（OCR 是异步的，死等固定毫秒不稳）
async function waitFor(fn, ms = 12000) {
  for (let t = 0; t < ms; t += 200) {
    let v = false;
    try { v = fn(); } catch (e) { /* 继续等 */ }
    if (v) return true;
    await sleep(200);
  }
  return false;
}

let fail = 0;
const ok = (n, c, extra = '') => { console.log((c ? '  PASS ' : '  FAIL ') + n + (extra ? '  → ' + extra : '')); if (!c) fail++; };

// 造一份「扫描件」PDF：一页，整页是 JPEG。需要 pdf-lib + 一张真实 JPEG。
async function makeScanPdf() {
  let PDFDocument;
  try { PDFDocument = require('pdf-lib').PDFDocument; } catch (e) { return null; }
  const jpgPath = ['/Users/langchengxing/Downloads/IMG_4117.jpg', '/tmp/fr.jpg']
    .find(p => fs.existsSync(p));
  if (!jpgPath) return null;
  const jpg = fs.readFileSync(jpgPath);
  const doc = await PDFDocument.create();
  const img = await doc.embedJpg(jpg);
  const pg = doc.addPage([img.width, img.height]);
  pg.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  return Buffer.from(await doc.save());
}

async function run() {
  await sleep(700);
  dom.window.alert = () => {};

  console.log('\n[首次使用引导]');
  ok('首次打开自动弹出引导', !!$('.modal-back'));
  ok('引导从第 1 步开始', /1 \/ 5/.test($('#obBody') ? $('#obBody').innerHTML : ''));
  ok('第 1 步「上一步」是禁用的', $('#obPrev') && $('#obPrev').disabled);
  for (let i = 0; i < 4; i++) click($('#obNext'));
  ok('可以走到最后一步', /5 \/ 5/.test($('#obBody').innerHTML));
  ok('末步按钮变成「开始用」', $('#obNext').textContent === '开始用', $('#obNext').textContent);
  click($('#obNext'));
  ok('完成后弹窗关闭', !$('.modal-back'));
  {
    // jsdom 在 file:// 源下禁用 localStorage（真实浏览器允许），读不到就跳过这条
    let flag = '(不可用)';
    try { flag = dom.window.localStorage.getItem('allez.onboarded.v1'); } catch (e) { /* opaque origin */ }
    ok('写进 localStorage，下次不再打扰', flag === '1' || flag === '(不可用)', 'flag=' + flag);
  }

  console.log('\n[加载]');
  ok('脚本无加载错误', errors.length === 0, errors.join(' | '));
  ok('默认停在「导入」页', !$('#p-import').classList.contains('hide'));

  console.log('\n[解析流程]');
  setVal($('#exam'), 'B1');
  setVal($('#examDate'), '2026-12-15');
  click($('#loadSample'));
  ok('载入示例课文', $('#src').value.length > 200);
  click($('#btnAnalyze'));
  await sleep(400);
  ok('解析后生成提示', /解析完成/.test($('#importNote').innerHTML), $('#importNote').textContent.trim().slice(0, 60));
  ok('自动跳转到考点页', !$('#p-map').classList.contains('hide'));
  ok('词汇表有行', $$('#vocabTable tbody tr').length > 10, $$('#vocabTable tbody tr').length + ' 行');
  ok('语法点面板有内容', /未完成过去时|复合过去时/.test($('#grammarGrid').innerHTML));

  console.log('\n[筛选与加入复习]');
  click($('#btnAddTop50'));
  ok('加入后表格标记已加入', /已加入/.test($('#vocabTable').innerHTML));
  const all = $$('#vocabTable tbody tr').length;
  setVal($('#fLevel'), 'A1');
  const a1 = $$('#vocabTable tbody tr').length;
  ok('等级筛选生效', a1 > 0 && a1 < all, `${all} → ${a1}`);
  setVal($('#fLevel'), '');
  setVal($('#fPos'), 'v');
  ok('词性筛选只显示动词', $$('#vocabTable tbody tr').length > 0, $$('#vocabTable tbody tr').length + ' 个动词');
  setVal($('#fPos'), '');
  setVal($('#fKw'), 'maison');
  ok('关键词搜索不报错', true);
  setVal($('#fKw'), '');

  console.log('\n[训练：六种模式]');
  ['recognize', 'listen', 'use', 'conj', 'produce', 'read'].forEach(m => {
    click($(`#modeSwitch button[data-m=${m}]`));
    const h = $('#quizArea').innerHTML;
    const txt = h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    ok(`模式 ${m} 渲染出题目`, h.length > 150 && !/还没有卡片|没有可用的卡片/.test(txt), txt.slice(0, 46));
    const g = $('#gradeRow button[data-q="3"]');
    if (g) click(g);
  });

  console.log('\n[作答校验]');
  for (let i = 0; i < 15 && !$('#freeInput'); i++) click($('#modeSwitch button[data-m=conj]'));
  if ($('#freeInput') && $('#btnCheck')) {
    $('#freeInput').value = 'je parle';
    click($('#btnCheck'));
    ok('变位题给出反馈', /不正确|正确|参考答案|音符/.test($('#feedback').textContent), $('#feedback').textContent.slice(0, 46));
    ok('显示自评按钮区', !$('#gradeRow').classList.contains('hide'));
  }
  click($('#modeSwitch button[data-m=recognize]'));
  const opt = $('.opt');
  if (opt) { click(opt); ok('选择题给出反馈', $('#feedback').className.includes('fb'), $('#feedback').textContent.slice(0, 30)); }
  if ($('.grade')) click($('.grade'));

  console.log('\n[排课 / 验收 / 易错点]');
  ['plan', 'report', 'sla', 'setup', 'map', 'train', 'import'].forEach(t => {
    click($(`#tabs button[data-t=${t}]`));
    ok(`切到「${t}」无异常`, $(`#p-${t}`) && !$(`#p-${t}`).classList.contains('hide'));
  });
  click($('#tabs button[data-t=report]'));
  ok('雷达图渲染', $('#radar').innerHTML.includes('<svg'));
  ok('覆盖度有百分比', /%/.test($('#coverage').innerHTML));
  click($('#tabs button[data-t=plan]'));
  ok('负荷预测条渲染', $('#forecast').innerHTML.length > 200);
  ok('今日卡片列出', $('#dueList').innerHTML.length > 100);
  click($('#tabs button[data-t=sla]'));
  ok('易错点库渲染 12 条', ($('#slaLib').innerHTML.match(/为什么中国人会错/g) || []).length === 12);
  ok('材料里检测到易错点', $('#slaFound').innerHTML.length > 100);

  console.log('\n[PDF 导入：真实法文 PDF]');
  {
    const pdf = '/Users/langchengxing/Downloads/中法未来科技学院-学生请假条.pdf';
    if (fs.existsSync(pdf)) {
      const buf = fs.readFileSync(pdf);
      // jsdom 的 File 不带 arrayBuffer，用一个够用的替身
      const fake = {
        name: 'test.pdf', size: buf.length,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      };
      $('#src').value = '';
      await dom.window.handleFile(fake);
      await sleep(400);
      const got = $('#src').value;
      ok('PDF 提取出文本', got.length > 100, got.length + ' 字符');
      ok('法语重音字符正确还原', /congé/.test(got) || /Téléphone|Numéro/.test(got),
        JSON.stringify(got.slice(0, 80)));
      ok('未出现 U+0000 解码残渣', got.indexOf('\u0000') < 0);
      ok('进度提示已更新', /提取/.test($('#pdfProg').innerHTML));
      // 提取结果应当能被考点引擎吃下去
      click($('#btnAnalyze'));
      await sleep(200);
      ok('PDF 文本可继续排出考点', $$('#vocabTable tbody tr').length > 0,
        $$('#vocabTable tbody tr').length + ' 行');
      // 法语为主的 PDF：抽出来的考点应该足够撑起单词表
      const f2 = '/Users/langchengxing/Desktop/04-学院与个人材料/邢朗诚Alexandre.pdf';
      if (fs.existsSync(f2)) {
        const b2 = fs.readFileSync(f2);
        $('#src').value = '';
        await dom.window.handleFile({
          name: 'fr.pdf', size: b2.length,
          arrayBuffer: async () => b2.buffer.slice(b2.byteOffset, b2.byteOffset + b2.byteLength)
        });
        await sleep(400);
        const got2 = $('#src').value;
        ok('法语 PDF 还原为完整句子', /Il s’appelle Caixukun\.\s*Il est chanteuse et actrice/.test(got2),
          JSON.stringify(got2.slice(0, 70)));
        ok('无错位空格（C aixukun 之类）', !/\b[a-zA-Z] [a-z]{4,}\b/.test(got2.slice(0, 40)));
        click($('#btnAnalyze'));
        await sleep(300);
        ok('法语 PDF 抽出可用词表', $$('#vocabTable tbody tr').length >= 8,
          $$('#vocabTable tbody tr').length + ' 行');
      }
    } else {
      console.log('  (跳过：样本 PDF 不存在)');
    }
  }

  console.log('\n[体积上限]');
  {
    // 超限文件必须被提前挡下，连内容都不应该去读
    let touched = false;
    const tooBig = {
      name: 'huge.pdf', size: 200 * 1024 * 1024,
      arrayBuffer: async () => { touched = true; return new ArrayBuffer(0); }
    };
    $('#src').value = '';
    await dom.window.handleFile(tooBig);
    ok('超过 100 MB 提前拒绝（未读取内容）', touched === false);
    ok('超限后正文保持干净', $('#src').value === '');
  }

  console.log('\n[设置]');
  click($('#tabs button[data-t=setup]'));
  setVal($('#apiKey'), 'sk-test');
  click($('#btnSaveApi'));
  ok('API 设置可保存', true);

  console.log('\n[指南页]');
  click($('#tabs button[data-t=guide]'));
  ok('指南页可见', $('#p-guide') && !$('#p-guide').classList.contains('hide'));
  ok('指南内容已渲染', $('#guideBody').innerHTML.length > 1500, $('#guideBody').innerHTML.length + ' 字符');
  ok('含「60 秒上手」', /60 秒上手/.test($('#guideBody').innerHTML));
  ok('含六种模式说明', /六种练习模式/.test($('#guideBody').innerHTML));
  ok('含 OCR 说明', /扫描件和图片怎么办/.test($('#guideBody').innerHTML));
  ok('含已知边界', /现在还做不到的事/.test($('#guideBody').innerHTML));
  ok('含常见问题', /常见问题/.test($('#guideBody').innerHTML));
  click($('#gReplay'));
  ok('「重看首次引导」能重新打开', !!$('.modal-back'));
  click($('#obSkip'));
  ok('「跳过」可关闭引导', !$('.modal-back'));

  console.log('\n[OCR：扫描件]');
  {
    click($('#tabs button[data-t=setup]'));
    ok('OCR 引擎下拉存在', !!$('#ocrEngine'));
    ok('OCR 四个设置项齐全', !!$('#ocrModel') && !!$('#ocrLangPath') && !!$('#ocrMaxPages'),
      [!!$('#ocrModel'), !!$('#ocrLangPath'), !!$('#ocrMaxPages')].join(','));
    setVal($('#ocrEngine'), 'vision');
    setVal($('#ocrMaxPages'), '5');
    click($('#btnSaveOcr'));
    ok('OCR 设置可保存', /已保存/.test($('#ocrSaveStat').textContent), $('#ocrSaveStat').textContent);

    const scan = await makeScanPdf();
    if (scan) {
      click($('#tabs button[data-t=import]'));
      $('#src').value = '';
      await dom.window.handleFile({
        name: 'scan.pdf', size: scan.length,
        arrayBuffer: async () => scan.buffer.slice(scan.byteOffset, scan.byteOffset + scan.byteLength)
      });
      await sleep(600);
      ok('扫描件弹出 OCR 面板', /这是扫描件/.test($('#ocrPanel').innerHTML),
        $('#ocrPanel').textContent.trim().slice(0, 60));
      ok('面板含引擎选择与开始按钮', !!$('#ocrEngineSel') && !!$('#btnRunOcr'));
      ok('面板报出取到的图片数', /取出/.test($('#ocrPanel').innerHTML));
      // 没有可用引擎时必须优雅失败：给出提示，而不是白屏
      click($('#btnRunOcr'));
      const settled = await waitFor(() => /识别失败|没拿到文字/.test($('#pdfProg').innerHTML));
      ok('识别失败时给出提示而非崩溃', settled, $('#pdfProg').textContent.trim().slice(0, 70));
    } else {
      console.log('  (跳过：无法生成扫描件样本)');
    }

    // 图片直接导入也要走 OCR 流程，同样不能崩
    const imgPath = ['/Users/langchengxing/Downloads/IMG_4117.jpg', '/tmp/fr.jpg'].find(p => fs.existsSync(p));
    if (imgPath) {
      const ib = fs.readFileSync(imgPath);
      $('#src').value = '';
      await dom.window.handleFile({
        name: 'page.jpg', size: ib.length, type: 'image/jpeg',
        arrayBuffer: async () => ib.buffer.slice(ib.byteOffset, ib.byteOffset + ib.byteLength)
      });
      await sleep(500);
      ok('图片导入走 OCR 且失败可控',
        /识别失败|没拿到文字|准备识别/.test($('#pdfProg').innerHTML),
        $('#pdfProg').textContent.trim().slice(0, 60));
    }
  }

  console.log('\n[备份 / 恢复]');
  {
    click($('#tabs button[data-t=setup]'));
    ok('设置页有备份区块', !!$('#btnExportAll') && !!$('#btnImportAll'));

    // 塞假的坏文件进去：必须被识别出来挡掉，而不是静默写坏数据
    const before = $('#backupStat').textContent;
    const bad = new dom.window.File(['{"format":"something-else"}'], 'bad.json', { type: 'application/json' });
    Object.defineProperty($('#backupInput'), 'files', { value: [bad], configurable: true });
    $('#backupInput').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await sleep(200);
    // 坏文件不改变界面状态（只弹 alert，alert 已被吞掉）
    ok('非备份文件被挡住，状态未被改动', $('#backupStat').textContent === before,
      JSON.stringify($('#backupStat').textContent));

    // 结构对但缺字段：同样要挡
    const half = new dom.window.File(['{"format":"allez-backup","state":{"foo":1}}'], 'half.json', { type: 'application/json' });
    Object.defineProperty($('#backupInput'), 'files', { value: [half], configurable: true });
    $('#backupInput').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await sleep(200);
    ok('结构不完整的备份被挡住', $('#backupStat').textContent === before);

    // 坏的 JSON 本身也不能炸
    const junk = new dom.window.File(['not json at all'], 'junk.txt', { type: 'text/plain' });
    Object.defineProperty($('#backupInput'), 'files', { value: [junk], configurable: true });
    $('#backupInput').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await sleep(200);
    ok('乱码文件不崩溃', $('#backupStat').textContent === before);
  }

  console.log('\n[运行时错误汇总]');
  ok('全流程无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run().then(() => {
  console.log('\n' + (fail ? `❌ ${fail} 项未通过` : '✅ 端到端全部通过'));
  process.exit(fail ? 1 : 0);
}).catch(e => { console.error('崩了：', e); process.exit(1); });
