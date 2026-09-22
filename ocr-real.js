/* 真实杂志 OCR 实测脚本
   用法：NODE_PATH=... node ocr-real.js [页数]
   1) 用 pdftext.js 抽取 PDF 自带文字层（扫描件通常为空）
   2) 用 ocr.js 抽出每页整页图片（CCITT/JPEG/Flate）
   3) 把图片写成 PNG/JPEG 存盘（供人眼对照"原文件"）
   4) 交给 Tesseract(fra) 识别
   5) 与 Internet Archive 自带的 _djvu.txt 参考答案对比
*/
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const OCR = require('./ocr.js');
const PDFText = require('./pdftext.js');
const Tesseract = require('tesseract.js');

const SAMPLE = path.join(__dirname, 'sample');
const PDF = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(SAMPLE, 'france-illustration-1950.pdf');
const NOPSM = process.env.PSM === 'default';
const TAG = path.basename(PDF, '.pdf') + (NOPSM ? '-psmDefault' : '');
const OUT = path.join(SAMPLE, 'pages-' + TAG);
const MAX = +(process.argv[2] || 3);

/* ---------------- 极简 PNG 编码（Node 没有 canvas） ---------------- */
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_T[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
// channels: 1=灰度 3=RGB
function encodePNG(w, h, pix, channels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = channels === 1 ? 0 : 2;
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pix.buffer, pix.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function pageToBuffer(img) {
  if (img.kind === 'jpeg') return { buf: Buffer.from(img.bytes), ext: 'jpg' };
  if (img.kind === 'bitmap') {
    const n = img.width * img.height, g = Buffer.alloc(n);
    for (let i = 0; i < n; i++) g[i] = img.bits[i] ? 0 : 255;   // 1=黑
    return { buf: encodePNG(img.width, img.height, g, 1), ext: 'png' };
  }
  if (img.kind === 'pixels') {
    const { width, height, comps, data, colorSpace } = img;
    const n = width * height;
    if (comps >= 3) {
      const rgb = Buffer.alloc(n * 3);
      for (let i = 0; i < n; i++) {
        const o = i * comps;
        if (colorSpace === 'CMYK') {
          const c = data[o] / 255, m = data[o + 1] / 255, y = data[o + 2] / 255, k = data[o + 3] / 255;
          rgb[i * 3] = 255 * (1 - c) * (1 - k); rgb[i * 3 + 1] = 255 * (1 - m) * (1 - k); rgb[i * 3 + 2] = 255 * (1 - y) * (1 - k);
        } else { rgb[i * 3] = data[o]; rgb[i * 3 + 1] = data[o + 1]; rgb[i * 3 + 2] = data[o + 2]; }
      }
      return { buf: encodePNG(width, height, rgb, 3), ext: 'png' };
    }
    const g = Buffer.alloc(n);
    for (let i = 0; i < n; i++) g[i] = data[i * comps];
    return { buf: encodePNG(width, height, g, 1), ext: 'png' };
  }
  return null;
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const bytes = fs.readFileSync(PDF);
  console.log('PDF 大小：' + (bytes.length / 1e6).toFixed(2) + ' MB');

  /* 1. 原生文字层 */
  console.log('\n[1] PDF 自带文字层…');
  let native = { text: '', pages: [], scanned: false };
  try {
    native = await PDFText.extractPdfText(bytes, () => { });
  } catch (e) { native = { text: '(抽取失败: ' + e.message + ')', pages: [], scanned: false }; }
  const nativeTrim = (native.text || '').replace(/\s+/g, ' ').trim();
  console.log('  文字层长度：' + nativeTrim.length + ' 字符，判定扫描件：' + native.scanned);
  console.log('  片段：' + nativeTrim.slice(0, 120));

  /* 2. 抽整页图片 */
  console.log('\n[2] 抽取页面图片…');
  const t0 = Date.now();
  const { pages, unsupported, pageCount } = await OCR.extractPageImages(bytes, (p, m) => {
    if (m && p % 25 === 0) process.stdout.write('\r  ' + m);
  });
  console.log('\r  总页数 ' + pageCount + '，成功抽图 ' + pages.length +
    '，不支持 ' + unsupported.length + '，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (unsupported.length) console.log('  不支持原因：' + unsupported.slice(0, 3).map(u => u.reason).join(' / '));
  pages.slice(0, 8).forEach(p => console.log('    第' + p.page + '页 ' + p.width + 'x' + p.height + ' ' + p.kind));

  /* 3. 存盘 */
  const use = pages.slice(0, MAX);
  console.log('\n[3] 写出前 ' + use.length + ' 页图片…');
  const files = [];
  use.forEach((img, i) => {
    const r = pageToBuffer(img);
    if (!r) { console.log('  第' + img.page + '页 无法编码'); return; }
    const f = path.join(OUT, 'page-' + img.page + '.' + r.ext);
    fs.writeFileSync(f, r.buf);
    files.push({ page: img.page, file: f, w: img.width, h: img.height, kind: img.kind });
    console.log('  ' + path.basename(f) + '  ' + img.width + 'x' + img.height + '  ' + (r.buf.length / 1024).toFixed(0) + 'KB');
  });

  /* 4. Tesseract 识别 */
  console.log('\n[4] Tesseract(fra) 识别…');
  const tessDir = process.argv[4]
    ? path.resolve(process.argv[4])
    : path.join(SAMPLE, 'tessdata-main');
  console.log('  语言包：' + tessDir);
  const worker = await Tesseract.createWorker('fra', 1, {
    cachePath: tessDir,                             // 命中本地训练数据，不联网
    cacheMethod: 'read',
    logger: m => { if (m.status && !/^loading/.test(m.status)) process.stdout.write('\r  ' + m.status + ' ' + Math.round((m.progress || 0) * 100) + '%   '); }
  });
  // 与 ocr.js 修复后的行为对齐：显式用 PSM 3，否则默认 6 会把插图当文字
  if (!NOPSM) await worker.setParameters({ tessedit_pageseg_mode: '3' });
  console.log('');
  const results = [];
  for (const f of files) {
    const t = Date.now();
    const { data } = await worker.recognize(f.file);
    const raw = data.text || '';
    const fixed = OCR.frenchCorrect(raw);
    const q = OCR.qualityOf(fixed);
    results.push({
      page: f.page, file: f.file, w: f.w, h: f.h, kind: f.kind,
      ms: Date.now() - t, conf: data.confidence,
      chars: raw.length, words: raw.trim().split(/\s+/).filter(Boolean).length,
      raw, fixed, quality: q
    });
    console.log('  第' + f.page + '页：' + ((Date.now() - t) / 1000).toFixed(1) + 's，' +
      results[results.length - 1].words + ' 词，置信度 ' + Math.round(data.confidence || 0) +
      '，质量 ' + q.level + '（' + q.note + '）');
  }
  await worker.terminate();

  fs.writeFileSync(path.join(SAMPLE, TAG + '.ocr.json'), JSON.stringify({ pdf: TAG, native: nativeTrim.slice(0, 2000), files, results }, null, 2));
  results.forEach(r => fs.writeFileSync(path.join(OUT, 'page-' + r.page + '.ocr.txt'), r.fixed));
  console.log('\n已写出 sample/' + TAG + '.ocr.json 与 ' + path.relative(process.cwd(), OUT) + '/*.ocr.txt');
})().catch(e => { console.error('失败：', e); process.exit(1); });
