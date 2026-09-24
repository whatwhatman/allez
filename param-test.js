/* 到底什么改变了结果？
   psm-test.js 里 page-2 得到 置信度89/78词，repro.js 里同样的图不设参数得到 35/645词。
   两者唯一差别是「有没有调用 setParameters」。逐项隔离。 */
const path = require('path');
const Tesseract = require('tesseract.js');
const S = path.join(__dirname, 'sample', 'original-2000');
const P = i => path.join(S, 'page-' + i + '.jpg');
const BASE = { cachePath: path.join(__dirname, 'sample', 'tessdata-main'), cacheMethod: 'read' };

async function run(name, params, seq) {
  const w = await Tesseract.createWorker('fra', 1, BASE);
  if (params) await w.setParameters(params);
  const rows = [];
  for (const i of seq) {
    const { data } = await w.recognize(P(i));
    rows.push(i + ':' + Math.round(data.confidence || 0) + '(' + (data.text || '').trim().split(/\s+/).filter(Boolean).length + '词)');
  }
  await w.terminate();
  console.log(name.padEnd(34) + ' → ' + rows.join('  '));
}

(async () => {
  console.log('（置信度(词数)）\n');
  await run('不调用 setParameters', null, [2, 3]);
  await run("setParameters(psm '3' 字符串)", { tessedit_pageseg_mode: '3' }, [2, 3]);
  await run('setParameters(psm 3 数字)', { tessedit_pageseg_mode: 3 }, [2, 3]);
  await run('setParameters(空对象)', {}, [2, 3]);
  await run("setParameters(psm '6')", { tessedit_pageseg_mode: '6' }, [2, 3]);
  await run('psm 3 + 保留词间空格', { tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' }, [2, 3]);
})();
