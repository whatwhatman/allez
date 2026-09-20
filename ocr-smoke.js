/* OCR 层冒烟测试 —— 只测不依赖 DOM 的纯逻辑
   跑法：node ocr-smoke.js
   重点验证 CCITT G4 解码：它是唯一一处「抄错一个码字就全盘皆输、而且不会报错」的代码。 */
const OCR = require('./ocr.js');
const T = OCR._tables;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  → ' + detail : '')); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, 'got=' + g + ' want=' + w);
}
function section(t) { console.log('\n[' + t + ']'); }

/* ---------------- 1. 码表本身的正确性 ---------------- */
section('CCITT 码表');
{
  // 前缀码必须无前缀：表里任一处抄错，几乎必然破坏这个性质
  const w = T.codesArePrefixFree(T.WHITE_TERM.concat(T.WHITE_MAKE));
  const b = T.codesArePrefixFree(T.BLACK_TERM.concat(T.BLACK_MAKE));
  ok('白码表无前缀冲突', w.ok, JSON.stringify(w));
  ok('黑码表无前缀冲突', b.ok, JSON.stringify(b));

  // 码字数量与取值
  eq('白终止码 64 条', T.WHITE_TERM.length, 64);
  eq('黑终止码 64 条', T.BLACK_TERM.length, 64);
  ok('无重复码字（白）', new Set(T.WHITE_TERM.concat(T.WHITE_MAKE)).size === T.WHITE_TERM.length + T.WHITE_MAKE.length);
  ok('无重复码字（黑）', new Set(T.BLACK_TERM.concat(T.BLACK_MAKE)).size === T.BLACK_TERM.length + T.BLACK_MAKE.length);
  ok('查找表构建无冲突', T.RUN_TABLES.white.bad.length === 0 && T.RUN_TABLES.black.bad.length === 0,
    JSON.stringify(T.RUN_TABLES.white.bad) + JSON.stringify(T.RUN_TABLES.black.bad));

  // 补充码的值必须是 64 的整数倍（这是 MH 编码能表示任意长度的前提）
  const badMake = [];
  T.WHITE_MAKE.forEach((c, k) => { if (T.RUN_TABLES.white.tbl.get(c) !== (k + 1) * 64) badMake.push('W' + k); });
  T.BLACK_MAKE.forEach((c, k) => { if (T.RUN_TABLES.black.tbl.get(c) !== (k + 1) * 64) badMake.push('B' + k); });
  ok('补充码值均为 64 的倍数', badMake.length === 0, badMake.join(','));
  ok('终止码值等于下标', T.WHITE_TERM.every((c, i) => T.RUN_TABLES.white.tbl.get(c) === i)
    && T.BLACK_TERM.every((c, i) => T.RUN_TABLES.black.tbl.get(c) === i));
}

/* ---------------- 2. 手工推导的位流向量 ---------------- */
section('G4 手工向量');

function bitsToBytes(bits) {
  while (bits.length % 8) bits += '0';
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i += 8) out[i >> 3] = parseInt(bits.slice(i, i + 8), 2);
  return out;
}
const EOFB = '000000000001000000000001';

{
  // 全白 16x4：参考行全白 → 每行只需 V0（'1'），a1=width，一行一位
  const w = 16, h = 4;
  let bits = '';
  for (let y = 0; y < h; y++) bits += '1';
  const out = OCR.ccittDecode(bitsToBytes(bits + EOFB), w, h, { K: -1, autoInvert: false });
  const allZero = Array.from(out).every(v => v === 0);
  ok('全白页解码为全 0（1=黑）', allZero && out.length === w * h,
    'len=' + out.length + ' sum=' + out.reduce((a, b) => a + b, 0));
}

{
  // 第 2 行画 4 个黑像素：只能用 Horizontal
  //   第1行 V0；第2行 001 + 白游程0(00110101) + 黑游程4(011) + V0 补到行尾
  const w = 16, h = 2;
  const bits = '1' + '001' + T.WHITE_TERM[0] + T.BLACK_TERM[4] + '1' + EOFB;
  const out = OCR.ccittDecode(bitsToBytes(bits), w, h, { K: -1, autoInvert: false });
  ok('第1行全白', Array.from(out.subarray(0, w)).every(v => v === 0), Array.from(out.subarray(0, w)).join(''));
  eq('第2行 = 4 黑 + 12 白', Array.from(out.subarray(w, w * 2)).join(''), '1111000000000000');
}

{
  // /Decode [1 0] 要整体翻转
  const w = 16, h = 1;
  const bits = '001' + T.WHITE_TERM[0] + T.BLACK_TERM[4] + '1' + EOFB;
  const a = OCR.ccittDecode(bitsToBytes(bits), w, h, { K: -1, autoInvert: false });
  const b = OCR.ccittDecode(bitsToBytes(bits), w, h, { K: -1, invert: true });
  eq('/Decode [1 0] 翻转', Array.from(b).map(v => v ? 0 : 1).join(''), Array.from(a).join(''));
}

{
  // autoInvert 兜底：整页黑多于白时自动倒回来
  const w = 16, h = 2;
  const allBlack = '001' + T.WHITE_TERM[0] + T.BLACK_TERM[16] + EOFB;
  const auto = OCR.ccittDecode(bitsToBytes(allBlack + allBlack), w, h, { K: -1 });
  let black = 0; auto.forEach(v => black += v);
  ok('autoInvert：全黑页被翻回白底', black * 2 <= auto.length, 'black=' + black + '/' + auto.length);
}

/* ---------------- 3. 自写编码器往返 ---------------- */
section('G4 编解码往返');

function encodeRun(len, color) {
  const TERM = color ? T.BLACK_TERM : T.WHITE_TERM;
  const MAKE = color ? T.BLACK_MAKE : T.WHITE_MAKE;
  let s = '', n = len;
  while (n >= 64) { const mk = Math.min(Math.floor(n / 64), 27); s += MAKE[mk - 1]; n -= mk * 64; }
  return s + TERM[n];
}
function runsOf(line, width) {
  const runs = []; let cur = 0, len = 0;
  for (let x = 0; x < width; x++) {
    if (line[x] === cur) len++;
    else { runs.push({ c: cur, len }); cur = line[x]; len = 1; }
  }
  runs.push({ c: cur, len });
  return runs;
}
// 纯 Horizontal 编码（合法的 G4 流）：每行把游程两两配对
function encodeHorizontalOnly(bm, width, height) {
  let bits = '';
  for (let y = 0; y < height; y++) {
    const runs = runsOf(bm.subarray(y * width, (y + 1) * width), width);
    for (let i = 0; i < runs.length; i += 2) {
      const r1 = runs[i], r2 = runs[i + 1];
      bits += '001' + encodeRun(r1.len, r1.c) + (r2 ? encodeRun(r2.len, r2.c) : encodeRun(0, 1));
    }
  }
  return bits + EOFB;
}
// 贪心 MMR 编码：能走 V 模式就走，否则 Horizontal —— 用来覆盖二维分支
function encodeMMR(bm, width, height) {
  let bits = '';
  let ref = new Uint8Array(width);
  const chgOf = line => { const r = []; let p = 0; for (let i = 0; i < width; i++) if (line[i] !== p) { r.push(i); p = line[i]; } return r; };
  for (let y = 0; y < height; y++) {
    const line = bm.subarray(y * width, (y + 1) * width);
    const t = chgOf(line), rc = chgOf(ref);
    let a0 = -1, color = 0, guard = 0;
    while (a0 < width && guard++ < width * 4 + 100) {
      const base = a0 < 0 ? 0 : a0;
      let b1 = width;
      for (const p of rc) if (p > a0 && ref[p] !== color) { b1 = p; break; }
      let a1 = width;
      for (const p of t) if (p > a0) { a1 = p; break; }
      if (a1 === width) {
        if (b1 === width) { bits += '1'; a0 = width; }
        else { bits += '001' + encodeRun(width - base, color) + encodeRun(0, color ? 0 : 1); a0 = width; }
        break;
      }
      const d = a1 - b1;
      if (d === 0) bits += '1';
      else if (d === 1) bits += '011';
      else if (d === 2) bits += '000011';
      else if (d === 3) bits += '0000011';
      else if (d === -1) bits += '010';
      else if (d === -2) bits += '000010';
      else if (d === -3) bits += '0000010';
      else {
        let a2 = width;
        for (const p of t) if (p > a1) { a2 = p; break; }
        bits += '001' + encodeRun(a1 - base, color) + encodeRun(a2 - a1, color ? 0 : 1);
        a0 = a2; continue;
      }
      a0 = a1; color = color ? 0 : 1;
    }
    ref = line;
  }
  return bits + EOFB;
}

function randBitmap(width, height, seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const bm = new Uint8Array(width * height);
  // 造点「像文字」的结构：横条 + 噪点，比纯随机更接近真实扫描件
  for (let y = 0; y < height; y++) {
    const bar = (y % 7 === 0) || (y % 7 === 1);
    for (let x = 0; x < width; x++) {
      let v = 0;
      if (bar && (x % 11) < 5) v = 1;
      if (rnd() < 0.02) v = v ? 0 : 1;
      bm[y * width + x] = v;
    }
  }
  return bm;
}

{
  const W = 64, H = 12;
  const bm = randBitmap(W, H, 42);
  const hBits = encodeHorizontalOnly(bm, W, H);
  const mBits = encodeMMR(bm, W, H);
  const gotH = OCR.ccittDecode(bitsToBytes(hBits), W, H, { K: -1, blackIs1: true });
  const gotM = OCR.ccittDecode(bitsToBytes(mBits), W, H, { K: -1, blackIs1: true });
  ok('Horizontal-only 往返一致', Array.from(gotH).join('') === Array.from(bm).join(''));
  const same = Array.from(gotM).join('') === Array.from(bm).join('');
  ok('贪心 MMR 往返一致', same);
  if (!same) {
    let bad = -1;
    for (let i = 0; i < bm.length; i++) if (bm[i] !== gotM[i]) { bad = i; break; }
    const y = Math.floor(bad / W);
    console.log('  首个分歧：行 ' + y + ' 列 ' + (bad % W));
    console.log('   原  : ' + Array.from(bm.subarray(y * W, (y + 1) * W)).join(''));
    console.log('   解码: ' + Array.from(gotM.subarray(y * W, (y + 1) * W)).join(''));
    if (y > 0) console.log('   上一: ' + Array.from(bm.subarray((y - 1) * W, y * W)).join(''));
  }
  ok('两种编码结果都可解码出非零内容', gotH.some(v => v) && gotM.some(v => v));

  // ASCII 预览，肉眼确认结构没散（前 12 行 x 前 40 列）
  const art = [];
  for (let y = 0; y < Math.min(H, 10); y++) {
    let s = '';
    for (let x = 0; x < Math.min(W, 40); x++) s += gotM[y * W + x] ? '#' : '.';
    art.push(s);
  }
  console.log('  --- 解码结果预览（#=黑） ---');
  art.forEach(l => console.log('  ' + l));
}

/* ---------------- 4. PNG 预测器还原 ---------------- */
section('Flate 预测器');
{
  // 造 2x2 RGB，用 Filter=1(Sub) 编码，看能否还原
  const w = 2, h = 2, bpp = 3;
  const orig = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
  const stride = w * bpp;
  const packed = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    packed[y * (stride + 1)] = 1;                       // Sub
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? orig[y * stride + x - bpp] : 0;
      packed[y * (stride + 1) + 1 + x] = (orig[y * stride + x] - a) & 0xff;
    }
  }
  const out = OCR.unpredict(packed, w, h, bpp);
  eq('Sub 预测器还原', Array.from(out).slice(0, 12), orig);
}

/* ---------------- 5. 法语后处理 ---------------- */
section('法语后处理');
{
  eq('弯引号归一', OCR.frenchCorrect('c\u2019est l\u2019\u00e9t\u00e9'), "c'est l'été");
  eq('连字展开', OCR.frenchCorrect('diﬃcile ﬁn'), 'difficile fin');
  eq('行尾断词合并', OCR.frenchCorrect('architec-\nture moderne'), 'architecture moderne');
  eq('甩到下一行的句号', OCR.frenchCorrect('Il fait beau\n. Vraiment'), 'Il fait beau. Vraiment');
  eq('孤立噪点行清除', OCR.frenchCorrect('Un texte\n|\nautre'), 'Un texte\nautre');
  eq('多余空白压缩', OCR.frenchCorrect('a   b\n\n\n\nc'), 'a b\n\nc');
  ok('空输入安全', OCR.frenchCorrect('') === '' && OCR.frenchCorrect(null) === '');
}

/* ---------------- 6. 识别质量粗判 ---------------- */
section('识别质量判定');
{
  eq('空文本', OCR.qualityOf('').level, 'empty');
  eq('像法语', OCR.qualityOf("Je m'appelle Léa et j'habite à Lyon depuis trois ans.").level, 'ok');
  eq('不成词（识别歪了）', OCR.qualityOf('zzz qqq www eee rrr ttt yyy uuu').level, 'low');
  eq('词太少', OCR.qualityOf('Le.').level, 'low');
}

/* ---------------- 7. Base64 ---------------- */
section('Base64');
{
  const u8 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  eq('JPEG 头编码正确', OCR.toBase64(u8), '/9j/4AAQ');
  ok('latin1 是 1:1 字节映射', (() => {
    const all = new Uint8Array(256); for (let i = 0; i < 256; i++) all[i] = i;
    const s = OCR.latin1(all);
    if (s.length !== 256) return false;
    for (let i = 0; i < 256; i++) if (s.charCodeAt(i) !== i) return false;
    return true;
  })());
}

/* ---------------- 8. 从扫描 PDF 里抽页面图片 ---------------- */
// 三种压缩方式各造一份 PDF。JPEG 那一份用的是合成字节（抽取阶段只认 FFD8 魔数，
// 不做真实解码），Flate / CCITT 两份则跑完整解码并逐像素比对。
function buildPdf(parts) {
  const bufs = [Buffer.from('%PDF-1.4\n', 'latin1')];
  parts.forEach((b, i) => {
    bufs.push(Buffer.from((i + 1) + ' 0 obj\n', 'latin1'));
    bufs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'));
    bufs.push(Buffer.from('\nendobj\n', 'latin1'));
  });
  return Buffer.concat(bufs);
}
function pageObj(w, h, imgRef) {
  return `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
    `/Resources << /XObject << /Im0 ${imgRef} 0 R >> >> /Contents 4 0 R >>`;
}
const CONTENT = '<< /Length 44 >>\nstream\nq 200 0 0 200 0 0 cm /Im0 Do Q\nendstream';

(async () => {
  section('扫描 PDF 抽图');

  // --- DCTDecode（JPEG）---
  {
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 0x5a)]);
    const imgObj = Buffer.concat([
      Buffer.from('<< /Type /XObject /Subtype /Image /Width 40 /Height 30 /ColorSpace /DeviceRGB ' +
        '/BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpg.length + ' >>\nstream\n', 'latin1'),
      jpg, Buffer.from('\nendstream', 'latin1')
    ]);
    const pdf = buildPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      pageObj(40, 30, 5), CONTENT, imgObj
    ]);
    const r = await OCR.extractPageImages(new Uint8Array(pdf), () => { });
    eq('JPEG：抽到 1 页', r.pages.length, 1);
    ok('JPEG：识别为 jpeg 类型', r.pages[0] && r.pages[0].kind === 'jpeg', r.pages[0] && r.pages[0].kind);
    eq('JPEG：尺寸正确', [r.pages[0].width, r.pages[0].height], [40, 30]);
    eq('JPEG：首字节是 FFD8', [r.pages[0].bytes[0], r.pages[0].bytes[1]], [0xff, 0xd8]);
  }

  // --- FlateDecode + PNG 预测器 ---
  {
    const W = 4, H = 3;
    const rgb = [];
    for (let i = 0; i < W * H * 3; i++) rgb.push((i * 7) & 0xff);
    const stride = W * 3;
    const packed = Buffer.alloc((stride + 1) * H);
    for (let y = 0; y < H; y++) {
      packed[y * (stride + 1)] = 0;                       // 每行 Filter=None
      for (let x = 0; x < stride; x++) packed[y * (stride + 1) + 1 + x] = rgb[y * stride + x];
    }
    const deflated = require('zlib').deflateSync(packed);
    const imgObj = Buffer.concat([
      Buffer.from('<< /Type /XObject /Subtype /Image /Width 4 /Height 3 /ColorSpace /DeviceRGB ' +
        '/BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 ' +
        '/BitsPerComponent 8 /Columns 4 >> /Length ' + deflated.length + ' >>\nstream\n', 'latin1'),
      deflated, Buffer.from('\nendstream', 'latin1')
    ]);
    const pdf = buildPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      pageObj(4, 3, 5), CONTENT, imgObj
    ]);
    const r = await OCR.extractPageImages(new Uint8Array(pdf), () => { });
    eq('Flate：抽到 1 页', r.pages.length, 1);
    ok('Flate：识别为 pixels 类型', r.pages[0] && r.pages[0].kind === 'pixels', r.pages[0] && r.pages[0].kind);
    eq('Flate：还原后像素与原图一致', Array.from(r.pages[0].data || []), rgb);
  }

  // --- CCITTFaxDecode（G4）走完整链路 ---
  {
    const W = 48, H = 8;
    const bm = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) if (y % 4 < 2) for (let x = 0; x < W; x++) if (x % 9 < 4) bm[y * W + x] = 1;
    const bits = encodeMMR(bm, W, H);
    while (bits.length % 8) bits += '0';
    const g4 = Buffer.alloc(bits.length / 8);
    for (let i = 0; i < bits.length; i += 8) g4[i >> 3] = parseInt(bits.slice(i, i + 8), 2);
    const imgObj = Buffer.concat([
      Buffer.from('<< /Type /XObject /Subtype /Image /Width 48 /Height 8 /ColorSpace /DeviceGray ' +
        '/BitsPerComponent 1 /ImageMask false /Filter /CCITTFaxDecode ' +
        '/DecodeParms << /K -1 /Columns 48 /Rows 8 /BlackIs1 false >> /Length ' + g4.length + ' >>\nstream\n', 'latin1'),
      g4, Buffer.from('\nendstream', 'latin1')
    ]);
    const pdf = buildPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      pageObj(48, 8, 5), CONTENT, imgObj
    ]);
    const r = await OCR.extractPageImages(new Uint8Array(pdf), () => { });
    eq('CCITT：抽到 1 页', r.pages.length, 1);
    ok('CCITT：识别为 bitmap 类型', r.pages[0] && r.pages[0].kind === 'bitmap', r.pages[0] && r.pages[0].kind);
    eq('CCITT：解码结果与原图一致', Array.from(r.pages[0].bits || []), Array.from(bm));
  }

  // --- 非 PDF 要报错，不能静默返回空 ---
  {
    let threw = false;
    try { await OCR.extractPageImages(new Uint8Array(Buffer.from('not a pdf at all')), () => { }); }
    catch (e) { threw = /不是一个 PDF/.test(e.message); }
    ok('非 PDF 文件明确报错', threw);
  }

  // --- 多页 + 取最大的那张图 ---
  {
    const jpgBig = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(600, 1)]);
    const jpgSmall = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(60, 1)]);
    const mk = (w, h, bytes) => Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`, 'latin1'),
      bytes, Buffer.from('\nendstream', 'latin1')
    ]);
    const pdf = buildPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
      pageObj(800, 600, 7), CONTENT,
      pageObj(400, 300, 9),
      '<< /Length 10 >>\nstream\nabcdefghij\nendstream',
      mk(800, 600, jpgBig), mk(20, 20, jpgSmall), mk(400, 300, jpgBig)
    ]);
    const r = await OCR.extractPageImages(new Uint8Array(pdf), () => { });
    eq('多页：抽到 2 页', r.pages.length, 2);
    eq('多页：第 1 页取最大的图', [r.pages[0].width, r.pages[0].height], [800, 600]);
    eq('多页：第 2 页尺寸', [r.pages[1].width, r.pages[1].height], [400, 300]);
  }

  console.log('\n' + (fail ? 'FAIL' : 'OK') + ' — ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
