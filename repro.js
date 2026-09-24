/* 隔离实验：同一个 worker 连续识别多页时，前一页会不会影响后一页？
   线索：单跑 page-2 置信度 89，但按 1→2→3→4 顺序跑时 page-2 只有 28。 */
const path = require('path');
const Tesseract = require('tesseract.js');
const S = path.join(__dirname, 'sample', 'original-2000');
const P = i => path.join(S, 'page-' + i + '.jpg');
const OPTS = { cachePath: path.join(__dirname, 'sample', 'tessdata-main'), cacheMethod: 'read' };

async function run(name, seq) {
  const w = await Tesseract.createWorker('fra', 1, OPTS);
  const rows = [];
  for (const i of seq) {
    const { data } = await w.recognize(P(i));
    rows.push(i + ':' + Math.round(data.confidence || 0) + '(' + (data.text || '').trim().split(/\s+/).filter(Boolean).length + '词)');
  }
  await w.terminate();
  console.log(name.padEnd(28) + ' → ' + rows.join('  '));
}

(async () => {
  console.log('（数字=置信度，括号=词数）\n');
  await run('A 只跑 page-2', [2]);
  await run('B 黑封面→page-2', [1, 2]);
  await run('C page-2→page-3', [2, 3]);
  await run('D page-1→2→3→4（原顺序）', [1, 2, 3, 4]);
  await run('E 颠倒 4→3→2', [4, 3, 2]);
  await run('F 只跑 page-3', [3]);
})();
