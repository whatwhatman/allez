/* 严格取证：每行用全新 worker，识别同两张图，并把 Tesseract 内部实际生效的
   页面分割模式（PSM）打出来，确认 setParameters 到底有没有生效。 */
const path = require('path');
const Tesseract = require('tesseract.js');
const S = path.join(__dirname, 'sample', 'original-2000');
const P = i => path.join(S, 'page-' + i + '.jpg');
const BASE = { cachePath: path.join(__dirname, 'sample', 'tessdata-main'), cacheMethod: 'read' };

async function cell(i, params) {
  const w = await Tesseract.createWorker('fra', 1, BASE);
  if (params) await w.setParameters(params);
  const { data } = await w.recognize(P(i), {}, { text: true, debug: true });
  await w.terminate();
  let psm = '?';
  try { psm = JSON.parse(data.debug).psm; } catch (e) { }
  return `${Math.round(data.confidence || 0)}分/${(data.text || '').trim().split(/\s+/).filter(Boolean).length}词/PSM=${psm}`;
}

(async () => {
  const cases = [
    ['（不设置）', null],
    ["psm '3'", { tessedit_pageseg_mode: '3' }],
    ["psm '6'", { tessedit_pageseg_mode: '6' }],
    ["psm '4'", { tessedit_pageseg_mode: '4' }],
    ["psm '11'", { tessedit_pageseg_mode: '11' }]
  ];
  console.log('页  配置             第1次                    第2次');
  for (const [name, p] of cases) {
    for (const page of [2, 3]) {
      const a = await cell(page, p);
      const b = await cell(page, p);
      console.log(`p${page}  ${name.padEnd(14)} ${a.padEnd(24)} ${b}`);
    }
  }
})();
