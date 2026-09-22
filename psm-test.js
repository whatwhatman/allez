/* 版面分割模式（PSM）对照实验
   Tesseract 默认 PSM 3（全自动）。杂志页是多栏密排 + 插图，PSM 选错会把
   插图当文字、把多栏串成一锅粥。这里对同一页跑不同 PSM，看差距有多大。 */
const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');

const SAMPLE = path.join(__dirname, 'sample');
const PAGES = [2, 3, 4];
const PSMS = [
  ['3', '全自动（默认）'],
  ['4', '单列可变字号'],
  ['6', '当成一整块文字'],
  ['11', '稀疏文字（找碎片）'],
  ['12', '稀疏文字+方向']
];

(async () => {
  const worker = await Tesseract.createWorker('fra', 1, {
    cachePath: path.join(SAMPLE, 'tessdata-main'), cacheMethod: 'read'
  });
  const out = [];
  for (const p of PAGES) {
    const f = path.join(SAMPLE, 'original-2000', 'page-' + p + '.jpg');
    for (const [psm, label] of PSMS) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const t = Date.now();
      const { data } = await worker.recognize(f);
      const txt = (data.text || '').trim();
      const words = txt.split(/\s+/).filter(w => /[A-Za-zÀ-ÿ]{2,}/.test(w));
      const row = {
        page: p, psm, label, conf: Math.round(data.confidence || 0),
        chars: txt.length, words: words.length,
        realWords: words.filter(w => /^[A-Za-zÀ-ÿ'’-]+$/.test(w)).length,
        sec: ((Date.now() - t) / 1000).toFixed(1), text: txt
      };
      out.push(row);
      console.log(`第${p}页 PSM${psm}(${label}) → 置信度 ${row.conf}，${row.words} 词，${row.chars} 字符，${row.sec}s`);
    }
  }
  await worker.terminate();
  fs.writeFileSync(path.join(SAMPLE, 'psm-result.json'), JSON.stringify(out, null, 2));
  console.log('\n已写出 sample/psm-result.json');
})();
