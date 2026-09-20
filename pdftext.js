/* ===========================================================
   pdftext.js —— 零依赖 PDF 文本提取器
   ------------------------------------------------------------
   不依赖 pdf.js / CDN / 服务器。浏览器用原生 DecompressionStream
   解压 FlateDecode，Node 下用 zlib。文件永远不离开本机。

   支持：
     · 页面树遍历（含间接引用、多 Kids）
     · FlateDecode（zlib 头 / raw deflate 自动尝试）
     · 字体编码：ToUnicode CMap（bfchar / bfrange）、
       Differences 偏移、WinAnsi / MacRoman / Standard 标准表
     · Type0(CID, 双字节) 与简单字体（单字节）
     · 内容流操作符：Tj TJ ' " Tf Td TD T* Tm Tc Tw TL
     · 行/段落重建：靠 y 位移与词间距阈值
   不支持：加密 PDF、纯扫描件（没有文本层的图片 PDF）。
   =========================================================== */

/* ---------------- 运行环境适配 ---------------- */
const IS_NODE = typeof module !== 'undefined' && module.exports;
let _zlib = null;
if (typeof require === 'function') { try { _zlib = require('zlib'); } catch (e) { /* 浏览器 */ } }

async function inflateBytes(bytes) {
  // Node 下走 zlib（同步、容错好）；浏览器下才用 DecompressionStream。
  if (_zlib) {
    try { return new Uint8Array(_zlib.inflateSync(Buffer.from(bytes))); } catch (e1) { /* 可能没 zlib 头 */ }
    try { return new Uint8Array(_zlib.inflateRawSync(Buffer.from(bytes))); } catch (e2) { /* 损坏 */ }
    try { return new Uint8Array(_zlib.inflateSync(Buffer.from(bytes), { finishFlush: _zlib.constants.Z_SYNC_FLUSH })); } catch (e3) { /* 放弃，转浏览器分支 */ }
  }
  if (typeof DecompressionStream === 'function') {
    for (const fmt of ['deflate', 'deflate-raw']) {
      try {
        const ds = new DecompressionStream(fmt);
        const chunks = [];
        const pipe = (async () => {
          const w = ds.writable.getWriter();
          await w.write(bytes);
          await w.close();
        })().catch(() => {});
        const reader = ds.readable.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        await pipe.catch(() => {});
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        chunks.forEach(c => { out.set(c, o); o += c.length; });
        if (out.length) return out;
      } catch (e) { /* 换下一种格式重试 */ }
    }
  }
  throw new Error('FlateDecode 解压失败：这个 PDF 的数据流可能已损坏，或使用了不支持的压缩算法。');
}

/* ---------------- 标准编码表 ---------------- */
function buildTable(str) { // 字符串索引即码位 + 0x80
  const t = {};
  for (let i = 0; i < str.length; i++) t[0x80 + i] = str[i];
  return t;
}

const WIN_ANSI = buildTable(
  '€\u0000‚ƒ„…†‡ˆ‰Š‹Œ\u0000Ž\u0000\u0000‘’“”•–—˜™š›œ\u0000žŸ' +
  ' ¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿' +
  'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞß' +
  'àáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ'
);

const MAC_ROMAN = buildTable(
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø' +
  '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ'
);

/* StandardEncoding：只填有把握的码位，其余故意留空。
   宁可丢一个字符，也不要把 è 错译成别的字母 —— 对法语这是灾难。 */
let _STANDARD = null;
function STANDARD() {
  if (_STANDARD) return _STANDARD;
  const NAMES = {
    0xA0: 'space', 0xA1: 'exclamdown', 0xA2: 'cent', 0xA3: 'sterling',
    0xA4: 'fraction', 0xA5: 'yen', 0xA6: 'florin', 0xA7: 'section',
    0xA8: 'currency', 0xA9: 'quotesingle', 0xAA: 'quotedblleft',
    0xAB: 'guilsinglleft', 0xAC: 'guilsinglright', 0xAD: 'fi', 0xAE: 'fl',
    0xAF: 'endash', 0xB0: 'dagger', 0xB1: 'daggerdbl', 0xB2: 'periodcentered',
    0xB3: 'paragraph', 0xB4: 'bullet', 0xB5: 'quotesinglbase', 0xB6: 'quotedblbase',
    0xB7: 'quotedblright', 0xB8: 'quotedblleft', 0xB9: 'quotedblbase',
    0xBA: 'quoteleft', 0xBB: 'quoteright', 0xBE: 'emdash'
  };
  _STANDARD = t;
  return t;
}

/* 单字节码位 → Unicode（先查 Differences/ToUnicode，再落到标准表） */
function baseEncode(code, font) {
  if (font.map.has(code)) return font.map.get(code);
  if (code < 0x80) return String.fromCharCode(code);
  const tbl = font.base === 'winansi' ? WIN_ANSI
    : font.base === 'macroman' ? MAC_ROMAN
      : STANDARD();
  return tbl[code] || '';
}

function glyphNameToUnicode(gn) {
  // 常见 Adobe 字形名 → unicode（法语够用即可）
  const SIMPLE = {
    space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
    ampersand: '&', quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')',
    asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/',
    colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@',
    bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_',
    grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
    quotesingle: "'", quotesinglbase: '‚', quotedblleft: '“', quotedblright: '”',
    quotedblbase: '„', guillemotleft: '«', guillemotright: '»', guilsinglleft: '‹',
    guilsinglright: '›', endash: '–', emdash: '—', bullet: '•', dagger: '†',
    daggerdbl: '‡', ellipsis: '…', perthousand: '‰', fi: 'fi', fl: 'fl',
    OE: 'Œ', oe: 'œ', AE: 'Æ', ae: 'æ', oslash: 'ø', Oslash: 'Ø', AEmacron: 'Ǣ', aemacron: 'ǣ',
    copyright: '©', registered: '®', trademark: '™', degree: '°', nbspace: ' ', nbspace2: ' ',
    sterling: '£', cent: '¢', yen: '¥', florin: 'ƒ', currency: '¤', section: '§',
    fraction: '⁄', paragraph: '¶', bullet2: '․', fiLig: 'ﬁ', flLig: 'ﬂ',
    uniFFFD: '�'
  };
  if (SIMPLE[gn]) return SIMPLE[gn];
  const uni = gn.match(/^uni([0-9A-Fa-f]{4})$/) || gn.match(/^u([0-9A-Fa-f]{4})$/);
  if (uni) return String.fromCharCode(parseInt(uni[1], 16));
  const acc = gn.match(/^([a-zA-Z]+)(acute|grave|circumflex|dieresis|tilde|cedilla|ring|caron|breve|macron|ogonek)$/);
  if (acc) {
    const BASE = { a: 'a', e: 'e', i: 'i', o: 'o', u: 'u', y: 'y', n: 'n', c: 'c', A: 'A', E: 'E', I: 'I', O: 'O', U: 'U', N: 'N', C: 'C' };
    const DIA = { acute: 0x0301, grave: 0x0300, circumflex: 0x0302, dieresis: 0x0308, tilde: 0x0303, cedilla: 0x0327, ring: 0x030A, caron: 0x030C, breve: 0x0306, macron: 0x0304, ogonek: 0x0328 };
    if (BASE[acc[1]]) {
      const pre = BASE[acc[1]] + String.fromCharCode(DIA[acc[2]]);
      return pre.normalize('NFC');
    }
  }
  return null;
}

/* CMap 里的 unicode 是 **UTF-16BE**，不是字节序列：
   <0044> 是字母 "D"，拆成 "00"+"44" 会拼出 U+0000 + "D"。
   必须先按 4 位十六进制（一个 UTF-16 码元）分组，这样 astral 平面
   的代理对也能正确还原。 */
function hexToUnicodeStr(h) {
  const s = String(h).replace(/[^0-9A-Fa-f]/g, '');
  if (!s) return '';
  if (s.length % 4 === 0) {
    const units = (s.match(/.{4}/g) || []).map(x => parseInt(x, 16));
    return String.fromCharCode.apply(null, units);
  }
  return (s.match(/.{2}/g) || []).map(x => String.fromCharCode(parseInt(x, 16))).join('');
}

/* ---------------- 字典 / 名字解析 ---------------- */
/* /W 里嵌了子数组： [3 [333] 15 [264] ...]
   用朴素正则 /\[([\s\S]*?)\]/ 会在第一个内层 ] 就收尾，只解析到 "3 [333"。
   必须做括号配平，宽度表才会完整。 */
function balancedArrayAfter(body, key) {
  const i = body.indexOf(key);
  if (i < 0) return null;
  const j = body.indexOf('[', i);
  if (j < 0) return null;
  let depth = 0;
  for (let k = j; k < body.length; k++) {
    if (body[k] === '[') depth++;
    else if (body[k] === ']') { depth--; if (depth === 0) return body.slice(j + 1, k); }
  }
  return null;
}

// /W 条目两种写法： c [w1 w2 w3]  或  cfirst clast w
function parseWEntries(inner, map) {
  const toks = inner.match(/\[[\s\S]*?\]|-?[\d.]+/g) || [];
  let i = 0;
  while (i < toks.length) {
    if (!/^-?[\d.]+$/.test(toks[i])) { i++; continue; }
    const c = parseInt(toks[i], 10);
    const n1 = toks[i + 1];
    if (n1 && n1[0] === '[') {
      (n1.slice(1, -1).match(/-?[\d.]+/g) || []).forEach((v, k) => map.set(c + k, parseFloat(v)));
      i += 2;
    } else if (n1 && /^-?[\d.]+$/.test(n1)) {
      const last = parseInt(n1, 10);
      const w = parseFloat(toks[i + 2] || '0');
      for (let k = c; k <= last && k - c < 65535; k++) map.set(k, w);
      i += 3;
    } else i++;
  }
}

function parseNameListBody(s) {
  // 解析 /Differences [ 32 /space /exclam ... ] 的数组体
  const out = [];
  const re = /(-?\d+|\/[\w#.-]+)/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1]);
  return out;
}

function decodeName(n) {
  if (n[0] !== '/') return null;
  return n.slice(1).replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function pdfDictGet(body, key) {
  // body 是对象字典的源文件串，返回值的原始串
  const re = new RegExp('/' + key + '\\s*(\\/[\\w#.-]+|\\[[\\s\\S]*?\\]|\\([\\s\\S]*?\\)|<[0-9A-Fa-f\\s]*>|-?[\\d.]+|\\d+\\s+\\d+\\s+R)', 'm');
  const m = body.match(re);
  return m ? m[1] : null;
}

/* ---------------- 主提取流程 ---------------- */
/**
 * @param {Uint8Array} bytes PDF 文件字节
 * @param {(pct:number,label:string)=>void} [onProgress]
 * @returns {Promise<{text:string, pages:string[], pageCount:number, fonts:number, scanned:boolean}>}
 */
async function extractPdfText(bytes, onProgress) {
  const noop = () => {};
  const prog = onProgress || noop;
  prog(5, '读取文件');

  const SUPPORTS_INFLATE = !!_zlib || typeof DecompressionStream === 'function';
  if (!SUPPORTS_INFLATE) {
    throw new Error('当前浏览器不支持解压 PDF（需要原生 DecompressionStream）。请升级到较新版本的 Chrome / Edge / Safari 16.4+ / Firefox 113+。');
  }
  // 解压失败记为硬错误：压缩字节当文本继续跑只会产出乱码
  let deflateFailed = false;

  // 千万别用 TextDecoder('latin1')：WHATWG 规范里 latin1 是 windows-1252 的别名，
  // 会把 0x80–0x9F 这些字节转义成 € ‚ ƒ，压缩流当场报废。
  // 用分块 fromCharCode，避免一次性生成上亿个字符把内存撑爆。
  const view = (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes))
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
  const raw = latin1(view);

  if (!/%PDF-/.test(raw.slice(0, 1024))) {
    if (!/%PDF-/.test(raw)) throw new Error('这不是一个 PDF 文件（可能上传错了，或者文件已损坏）。');
  }
  if (/\/Encrypt\b/.test(raw)) {
    throw new Error('这个 PDF 被加密了（带权限密码）。请先用系统自带的预览导出一份无密码版本。');
  }

  /* --- 1. 建对象表（暴力扫描，兼容 xref 损坏的老 PDF） --- */
  const objs = new Map();
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let om;
  const marks = [];
  while ((om = objRe.exec(raw)) !== null) marks.push({ num: +om[1], start: om.index + om[0].length });
  for (let i = 0; i < marks.length; i++) {
    const endIdx = raw.indexOf('endobj', marks[i].start);
    const stop = endIdx < 0 ? Math.min(raw.length, marks[i].start + 1e7) : endIdx;
    objs.set(marks[i].num, raw.slice(marks[i].start, stop));
  }

  /* --- 1b. 摊平对象流（PDF 1.5+；macOS Quartz、pdf-lib 默认就这么写） ---
     不处理的话这些 PDF 会被当成「空文档」，上面还会误报成扫描件。 */
  for (const [num, body] of Array.from(objs)) {
    if (!/\/ObjStm/.test(body)) continue;
    const firstM = body.match(/\/First\s+(\d+)/);
    const si2 = body.search(/\bstream\b/);
    if (!firstM || si2 < 0) continue;
    const first = +firstM[1];
    let ds = si2 + 6;
    if (body[ds] === '\r') ds++;
    if (body[ds] === '\n') ds++;
    const lenM = body.match(/\/Length\s+(\d+)/);
    const e2 = lenM ? Math.min(body.length, ds + +lenM[1]) : body.indexOf('endstream', ds);
    let data;
    try {
      data = await inflateBytes(Uint8Array.from(body.slice(ds, e2 < 0 ? body.length : e2), c => c.charCodeAt(0) & 0xff));
    } catch (err) { continue; }
    const head = latin1(data.subarray(0, Math.min(first, data.length)));
    const pairs = (head.match(/(\d+)\s+(\d+)/g) || []).map(s => s.split(/\s+/).map(Number));
    for (let i = 0; i < pairs.length; i++) {
      const onum = pairs[i][0], off = pairs[i][1];
      const end = i + 1 < pairs.length ? pairs[i + 1][1] : data.length - first;
      objs.set(onum, latin1(data.subarray(first + off, first + end)));
    }
  }
  prog(15, '建立对象索引');

  /* --- 2. 取流（解压） --- */
  const streamCache = new Map();
  async function streamOf(num) {
    if (streamCache.has(num)) return streamCache.get(num);
    let body = objs.get(num) || '';
    let refAGAIN = body.match(/^\s*([\s\S]*?)\s+(\d+)\s+(\d+)\s+R\s*$/);
    // 处理 Contents 指向裸流的间接引用链
    let hop = 0;
    while (refAGAIN && hop++ < 5) {
      const t = objs.get(+refAGAIN[2]);
      if (!t) break;
      body = t; refAGAIN = body.match(/^\s*([\s\S]*?)\s+(\d+)\s+(\d+)\s+R\s*$/);
    }
    const si = body.search(/\bstream\b/);
    let out = null;
    if (si >= 0) {
      let head = body.slice(0, si);
      // PDF 规范：stream 关键字后必须跳过一个 CRLF 或 LF（只跳一次），
      // 忽略了这一步，解压器会把前导换行当 zlib 头，直接报 "incorrect header check"。
      let dataStart = si + 6;
      if (body[dataStart] === '\r') dataStart++;
      if (body[dataStart] === '\n') dataStart++;
      const filter = /\/Filter\s*\/(\w+)/.test(head) ? head.match(/\/Filter\s*\/(\w+)/)[1] : null;
      // 先按 Length 取，失败就退到 endstream
      let lenM = head.match(/\/Length\s+(\d+)/);
      let dataEnd = -1;
      if (lenM) {
        dataEnd = Math.min(body.length, dataStart + +lenM[1]);
        if (body.slice(dataEnd, dataEnd + 12).indexOf('endstream') < 0) dataEnd = -1;
      }
      if (dataEnd < 0) {
        const e = body.indexOf('endstream', dataStart);
        dataEnd = e < 0 ? body.length : e;
      }
      let slice = body.slice(dataStart, dataEnd);
      const u8 = Uint8Array.from(slice, c => c.charCodeAt(0) & 0xff);
      if (filter === 'FlateDecode' || (filter === null && /\x78[\x01\x9c\xda]/.test(slice.slice(0, 2)))) {
        try { out = await inflateBytes(u8); } catch (e) { deflateFailed = true; out = new Uint8Array(0); }
      } else {
        out = u8; // 未压缩或其它过滤器
      }
    }
    streamCache.set(num, out);
    return out;
  }

  function latin1(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return s;
  }

  /* --- 3. 解析字体 --- */
  const fontCache = new Map();
  let ttFontLike = 0;
  async function makeFont(fontObjBody) {
    const key = fontObjBody;
    if (fontCache.has(key)) return fontCache.get(key);
    // 未声明编码时按 WinAnsi 兜底：它覆盖法语全部重音符号，
    // 也是 Word / LibreOffice / LaTeX 导出件的事实标准。
    const font = { two: false, map: new Map(), widths: new Map(), dw: 1000, base: 'winansi', diffCode: null };
    const sub = (fontObjBody.match(/\/Subtype\s*\/(\w+)/) || [])[1] || 'TrueType';
    font.two = sub === 'Type0';
    ttFontLike++;

    // ToUnicode CMap → cid 到 unicode
    const tu = fontObjBody.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (tu) {
      try {
        const cmap = latin1(await streamOf(+tu[1]) || new Uint8Array(0));
        parseCMap(cmap, font.map);
        font.base = 'cmap';
      } catch (e) { /* 忽略损坏的 CMap */ }
    }

    // Differences → 简单字体编码偏移
    const encRef = fontObjBody.match(/\/Encoding\s+(\d+)\s+\d+\s+R/);
    let encBody = fontObjBody;
    if (encRef) encBody = objs.get(+encRef[1]) || encBody;
    const baseM = encBody.match(/\/BaseEncoding\s*\/(\w+)/);
    if (baseM) font.base = baseM[1].toLowerCase();
    else if (/\/Encoding\s*\/(WinAnsi|MacRoman|MacExpert|Standard)Encoding/.test(encBody)) {
      font.base = encBody.match(/\/Encoding\s*\/(WinAnsi|MacRoman|MacExpert|Standard)Encoding/)[1].toLowerCase();
    }
    const diffSeg = encBody.slice(encBody.indexOf('/Differences'));
    if (diffSeg.indexOf('/Differences') === 0) {
      const arrEnd = diffSeg.indexOf(']');
      const arr = diffSeg.slice(diffSeg.indexOf('[') + 1, arrEnd > 0 ? arrEnd : diffSeg.length);
      const items = parseNameListBody(arr);
      let code = -1;
      items.forEach(it => {
        if (/^-?\d+$/.test(it)) code = +it;
        else if (code >= 0) { font.map.set(code++, glyphNameToUnicode(it) || ''); }
      });
    }
    // 字形宽度表：有了它才能精确判断「两个词之间到底有没有空格」，
    // 否则只能靠估算，中文字体把拉丁字母按全角排时会全盘判错。
    if (font.two) {
      const desc = fontObjBody.match(/\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/);
      const cfb = desc ? objs.get(+desc[1]) : null;
      if (cfb) {
        const dwM = cfb.match(/\/DW\s+(-?[\d.]+)/);
        if (dwM) font.dw = parseFloat(dwM[1]);
        let wBody = cfb;
        const wRef = cfb.match(/\/W\s+(\d+)\s+\d+\s+R/);
        if (wRef && objs.get(+wRef[1])) wBody = objs.get(+wRef[1]);
        const inner = balancedArrayAfter(wBody, '/W');
        if (inner) parseWEntries(inner, font.widths);
      }
    } else {
      const fcM = fontObjBody.match(/\/FirstChar\s+(-?\d+)/);
      const wM = fontObjBody.match(/\/Widths\s*\[([\s\S]*?)\]/);
      if (fcM && wM) {
        const first = +fcM[1];
        (wM[1].match(/-?[\d.]+/g) || []).forEach((v, k) => font.widths.set(first + k, parseFloat(v)));
      }
    }

    // Type0 的后代字体常带有 CIDToGIDMap，这里不需要
    fontCache.set(key, font);
    return font;
  }

  function parseCMap(cmap, map) {
    // bfchar
    const re1 = /beginbfchar([\s\S]*?)endbfchar/g;
    let m;
    while ((m = re1.exec(cmap)) !== null) {
      const inner = m[1];
      const p = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f\s]+)>/g;
      let x;
      while ((x = p.exec(inner)) !== null) {
        const id = parseInt(x[1], 16);
        map.set(id, hexToUnicodeStr(x[2]));
      }
    }
    // bfrange
    const re2 = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = re2.exec(cmap)) !== null) {
      const inner = m[1];
      const p = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f\s]+)>|\[([\s\S]*?)\])/g;
      let x;
      while ((x = p.exec(inner)) !== null) {
        const lo = parseInt(x[1], 16), hi = parseInt(x[2], 16);
        if (x[3]) {
          let base = parseInt(x[3].replace(/\s/g, '').slice(-4), 16);
          for (let c = lo; c <= hi && c - lo < 65535; c++) map.set(c, String.fromCharCode(base + (c - lo)));
        } else if (x[4]) {
          const arr = (x[4].match(/<[0-9A-Fa-f\s]+>/g) || []);
          arr.forEach((hx, k) => {
            const us = hx.slice(1, -1).replace(/\s/g, '').match(/../g) || [];
            map.set(lo + k, us.map(h => String.fromCharCode(parseInt(h, 16))).join(''));
          });
        }
      }
    }
    // cidrange 里 direct unicode 早已是 unicode，可直接忽略
  }

  /* --- 4. 页面树 --- */
  const pages = [];
  const catalogM = raw.match(/Type\s*\/Catalog[\s\S]{0,400}?\/Pages\s+(\d+)\s+\d+\s+R/);
  let rootNum = catalogM ? +catalogM[1] : null;
  if (rootNum === null) {
    // 兜底：第一个 /Type /Pages 对象
    for (const [n, b] of objs) if (/\/Type\s*\/Pages\b/.test(b) && !/\/Type\s*\/Page\b/.test(b)) { rootNum = n; break; }
  }
  function walk(nodeNum, depth) {
    if (depth > 24) return;
    const b = objs.get(nodeNum);
    if (!b) return;
    if (/\/Type\s*\/Page\b/.test(b)) { pages.push(nodeNum); return; }
    const kidsSeg = b.slice(b.indexOf('/Kids'));
    const arrEnd = kidsSeg.indexOf(']');
    const kidsStr = kidsSeg.slice(kidsSeg.indexOf('[') + 1, arrEnd > 0 ? arrEnd : kidsSeg.length);
    const nums = (kidsStr.match(/(\d+)\s+\d+\s+R/g) || []).map(s => +s.match(/^(\d+)/)[1]);
    nums.forEach(n => walk(n, depth + 1));
  }
  if (rootNum !== null) walk(rootNum, 0);
  if (!pages.length) {
    // 最后兜底：所有 /Type /Page 对象（乱序）
    for (const [n, b] of objs) if (/\/Type\s*\/Page\b/.test(b)) pages.push(n);
  }
  pages.sort((a, c) => a - c);
  prog(25, `共 ${pages.length} 页`);

  /* --- 5. 逐页渲染文本 --- */
  const outPages = [];
  let totalChars = 0;
  for (let pi = 0; pi < pages.length; pi++) {
    const body = objs.get(pages[pi]) || '';
    const resRef = (body.match(/\/Resources\s+(\d+)\s+\d+\s+R/) || [])[1];
    const resBody = resRef ? (objs.get(+resRef) || '') : body.slice(body.indexOf('/Resources'));
    const fontNames = new Map();   // /F1 → fontObjBody
    const fSegStart = resBody.indexOf('/Font');
    if (fSegStart >= 0) {
      const seg = resBody.slice(fSegStart);
      const dictEnd = seg.indexOf('>>');
      const fstr = seg.slice(0, dictEnd > 0 ? dictEnd : seg.length);
      const re = /(\/[\w#.-]+)\s+(\d+)\s+\d+\s+R/g;
      let m;
      while ((m = re.exec(fstr)) !== null) {
        const fb = objs.get(+m[2]);
        if (fb) fontNames.set(m[1], fb);
      }
    }

    // Contents：可能是单引用也可能是引用数组
    let contentNums = [];
    const contSeg = body.slice(body.indexOf('/Contents'));
    const cArrBracket = contSeg.indexOf('[');
    const toSE = contSeg.indexOf('/');
    if (cArrBracket >= 0 && (toSE < 0 || cArrBracket < toSE + 12)) {
      const arrEnd = contSeg.indexOf(']', cArrBracket);
      const arr = contSeg.slice(cArrBracket + 1, arrEnd > 0 ? arrEnd : contSeg.length);
      contentNums = (arr.match(/(\d+)\s+\d+\s+R/g) || []).map(s => +s.match(/^(\d+)/)[1]);
    } else {
      const c = (contSeg.match(/(\d+)\s+\d+\s+R/) || [])[1];
      if (c) contentNums = [+c];
    }

    let pageText = '';
    for (const cn of contentNums) {
      let cs = null;
      try { const u8 = await streamOf(cn); if (u8) cs = latin1(u8); } catch (e) { cs = null; }
      if (!cs) continue;
      pageText += await renderContent(cs, fontNames, makeFont);
    }
    outPages.push(pageText);
    totalChars += pageText.length;
    prog(25 + Math.round(70 * (pi + 1) / Math.max(1, pages.length)), `提取第 ${pi + 1}/${pages.length} 页`);
  }

  let text = outPages.join('\n\n');

  if (deflateFailed && !text.trim()) {
    throw new Error('PDF 数据流解压失败，文件可能已损坏或使用了不支持的压缩算法（如 LZW / JPEG2000 封装的字体）。');
  }

  text = postProcess(text);
  prog(100, '完成');

  const bodies = text.replace(/\s/g, '');
  return {
    text,
    pages: outPages.map(postProcess),
    pageCount: pages.length,
    fonts: ttFontLike,
    scanned: pages.length > 0 && bodies.length < pages.length * 20
  };
}

/* ---------------- 内容流渲染 ---------------- */
/* 关键点：WPS / Word / LaTeX 导出的 PDF 常常**逐字形**绘制（每个字符
   一个 Tm + Tj + TD），所以不能用 「BT/ET 边界」当行边界，否则每个
   字母都会被切成独立一行，法语课文全散架。
   正确做法是维护标准的文本矩阵 [a b c d e f]，把 (e,f) 换算成页面用户
   坐标，靠 y 的跳变换行、靠估算的字距（EMA）补空格。 */
async function renderContent(cs, fontNames, makeFont) {
  let mtx = [1, 0, 0, 1, 0, 0];   // a b c d e f
  let fontSize = 12, leading = 0, charSpacing = 0, wordSpacing = 0;
  let curFont = null;
  let lineBuf = '';
  const lines = [];
  let curLineY = null;
  let lastX = null, lastLen = 0, unit = null;   // 字宽估计（EMA）

  const fontFor = async name => {
    const fb = fontNames.get(name) || fontNames.get('/' + String(name).replace(/^\//, ''));
    return fb ? makeFont(fb) : null;
  };

  const effSize = () => {
    const s = fontSize * Math.hypot(mtx[1], mtx[3]);
    return (isFinite(s) && s > 0) ? s : fontSize;
  };
  const translate = (tx, ty) => {
    const [a, b, c, d, e, f] = mtx;
    mtx = [a, b, c, d, a * tx + c * ty + e, b * tx + d * ty + f];
  };
  const flush = () => { if (lineBuf.trim()) lines.push(lineBuf); lineBuf = ''; };

  let lastEndX = null;             // 上一次绘制按字宽推算的终点（用户坐标）

  // 绘制前：决定是否换行、是否补空格
  const beforeDraw = () => {
    const y = mtx[5], x = mtx[4], es = effSize();
    if (curLineY === null) { curLineY = y; lastX = null; lastEndX = null; return; }
    if (Math.abs(y - curLineY) > Math.max(1.2, es * 0.4)) {
      flush(); curLineY = y; lastX = null; lastEndX = null; unit = null; return;
    }
    let needSpace = false;
    if (lastEndX !== null) needSpace = (x - lastEndX) > es * 0.28;
    else if (lastX !== null && unit) needSpace = (x - (lastX + lastLen * unit)) > unit * 0.5;
    if (needSpace && !/[ \t]$/.test(lineBuf) && lineBuf !== '') lineBuf += ' ';
  };

  // 绘制后：用 PDF 自带的字宽表推算这段文本的终点
  const afterDraw = (s, codes, f) => {
    const x = mtx[4];
    const hScale = Math.hypot(mtx[0], mtx[1]) || 1;
    let advance = 0, known = false;
    if (f && codes.length) {
      let has = true;
      for (const c of codes) {
        if (f.widths.has(c)) advance += f.widths.get(c);
        else { has = false; break; }
      }
      known = has;
    }
    if (known && codes.length) {
      lastEndX = x + (advance / 1000) * fontSize * hScale + charSpacing * codes.length * hScale;
    } else {
      lastEndX = null;   // 退回 EMA 估算
      if (lastX !== null && lastLen > 0) {
        const cand = (x - lastX) / lastLen;
        if (cand > 0.05) unit = (unit === null) ? cand : unit * 0.75 + Math.min(cand, unit * 2.2) * 0.25;
      }
    }
    lastX = x;
    lastLen = Math.max(1, s.length);
  };

  /* 字符串解码 ------------------------------------------------ */
  const decodeLiteral = async (op, f) => {
    const inner = unescapePdfString(op.slice(1, op.lastIndexOf(')')));
    if (!f) return { t: inner.replace(/[^ -~À-ÿ]/g, ''), codes: [] };
    let out = '';
    const codes = [];
    for (let i = 0; i < inner.length; i++) {
      const c = inner.charCodeAt(i);
      if (f.two) {
        const cid = (c << 8) | (inner.charCodeAt(i + 1) || 0);
        i++;
        codes.push(cid);
        out += f.map.has(cid) ? f.map.get(cid) : (cid > 0x20 ? '�' : '');
      } else {
        codes.push(c);
        out += baseEncode(c, f) || (c >= 32 ? String.fromCharCode(c) : '');
      }
    }
    return { t: out, codes };
  };

  const decodeHex = async (op, f) => {
    let h = op.slice(1, op.indexOf('>')).replace(/[^0-9A-Fa-f]/g, '');
    if (h.length % 2) h += '0';
    const bytes = h.match(/../g) || [];
    if (!f) return { t: bytes.map(b => String.fromCharCode(parseInt(b, 16))).join(''), codes: [] };
    let out = '';
    const codes = [];
    if (f.two) {
      for (let i = 0; i < bytes.length; i += 2) {
        const cid = (parseInt(bytes[i], 16) << 8) | (parseInt(bytes[i + 1] || '0', 16));
        codes.push(cid);
        out += f.map.has(cid) ? f.map.get(cid) : (cid > 0x20 ? '�' : '');
      }
    } else {
      bytes.forEach(b => {
        const c = parseInt(b, 16);
        codes.push(c);
        out += baseEncode(c, f) || (c >= 32 ? String.fromCharCode(c) : '');
      });
    }
    return { t: out, codes };
  };

  const decodeOperand = async (op, f) => {
    if (op[0] === '(') return await decodeLiteral(op, f);
    if (op[0] === '<') return await decodeHex(op, f);
    return { t: '', codes: [] };
  };

  /* 用正则逐 token 扫描：兼容 \r、单个超长行、无换行的紧凑流 */
  const tokRe = /(\/[A-Za-z0-9#.\-+]+)|(\[\s*(?:[^\[\]]|\[[\s\S]*?\])*\])|(\((?:\\.|[^\\()])*\))|(<[0-9A-Fa-f\s]*>)|(-?\d*\.?\d+)|([A-Za-z'"]+)/g;
  const tokens = [];
  let tk;
  while ((tk = tokRe.exec(cs)) !== null) tokens.push(tk[0]);

  let i = 0;
  let pending = [];
  const isOperand = t => !/^[A-Za-z'"]+$/.test(t);

  while (i < tokens.length) {
    const t = tokens[i];
    if (isOperand(t)) { pending.push(t); i++; continue; }
    const op = t;
    const args = pending; pending = [];
    i++;

    switch (op) {
      case 'BT':
        mtx = [1, 0, 0, 1, 0, 0];
        lastX = null; lastEndX = null; unit = null;   // 但不 flush：一个 BT/ET 块常只有一个字形
        break;
      case 'ET':
        // 故意不 flush：一个 BT/ET 块里往往只有一个字形
        break;
      case 'Tf': {
        const fname = args[args.length - 2];
        const sz = parseFloat(args[args.length - 1]);
        if (!isNaN(sz)) fontSize = sz;
        if (fname) curFont = await fontFor(fname);
        break;
      }
      case 'Tc': { const v = parseFloat(args[args.length - 1]); if (!isNaN(v)) charSpacing = v; break; }
      case 'Tw': { const v = parseFloat(args[args.length - 1]); if (!isNaN(v)) wordSpacing = v; break; }
      case 'TL': { const v = parseFloat(args[args.length - 1]); if (!isNaN(v)) leading = v; break; }
      case 'Td': case 'TD': {
        const dx = parseFloat(args[args.length - 2]) || 0;
        const dy = parseFloat(args[args.length - 1]) || 0;
        if (op === 'TD') leading = -dy;
        translate(dx, dy);
        break;
      }
      case 'T*': translate(0, -leading || -fontSize * 1.2); break;
      case 'Tm': {
        if (args.length >= 6) {
          const n = args.slice(-6).map(parseFloat);
          if (n.every(v => !isNaN(v))) mtx = n;
        }
        break;
      }
      case 'Tj': {
        beforeDraw();
        const d0 = await decodeOperand(args[args.length - 1] || '()', curFont);
        lineBuf += d0.t;
        if (d0.t) afterDraw(d0.t, d0.codes, curFont);
        break;
      }
      case 'TJ': {
        const items = parseTJArray(args[args.length - 1] || '[]');
        let drew = '';
        for (const it of items) {
          if (typeof it === 'number') {
            translate((-it / 1000) * fontSize, 0);
            if (Math.abs(it) / 1000 > 0.18 && !/[ \t]$/.test(lineBuf) && lineBuf) lineBuf += ' ';
          } else {
            beforeDraw();
            const d = await decodeOperand(it, curFont);
            lineBuf += d.t;
            if (d.t) { afterDraw(d.t, d.codes, curFont); drew += d.t; }
          }
        }
        if (!drew) afterDraw(' ', [], curFont);
        break;
      }
      case "'": case '"': {
        translate(0, -leading || -fontSize * 1.2);
        beforeDraw();
        const d = await decodeOperand(args[args.length - 1] || '()', curFont);
        lineBuf += d.t;
        if (d.t) afterDraw(d.t, d.codes, curFont);
        break;
      }
      default: break;
    }
  }
    return lines.join('\n');
}

function parseTJArray(arrStr) {
  const inner = arrStr.replace(/^\[/, '').replace(/\]$/, '');
  const out = [];
  const re = /(\((?:\\.|[^\\()])*\))|(<[0-9A-Fa-f\s]*>)|(-?\d*\.?\d+)/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    if (m[1] || m[2]) out.push(m[1] || m[2]);
    else if (m[3] && m[3] !== '-') out.push(parseFloat(m[3]));
  }
  return out;
}

function unescapePdfString(s) {
  return s
    .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c]))
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\\n/g, '');
}

/* ---------------- 后处理 ---------------- */
function postProcess(t) {
  return t
    // 连字 → 常规写法（法语常见）
    .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬀ/g, 'ff').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    // 软连字符
    .replace(/\u00AD/g, '')
    // 被换行切断的单词：architec-\nture → architecture
    .replace(/([A-Za-zÀ-ÿ])-[ \t]*\n+[ \t]*(?=[a-zà-ÿ])/g, '$1')
    // 排版换行把标点甩到下一行：café\n. → café.
    .replace(/([A-Za-zÀ-ÿ0-9»”’)])\n+([.,;:!?»”)])/g, '$1$2')
    // 上一行以逗号/分号结尾、下一行以小写字母开头，多半是腰斩的句子
    .replace(/([,;])\n+(?=[a-zà-ÿ])/g, '$1 ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/* ---------------- 导出 ---------------- */
const PDFText = { extractPdfText };
if (IS_NODE) module.exports = PDFText;
else if (typeof window !== 'undefined') window.PDFText = PDFText;
