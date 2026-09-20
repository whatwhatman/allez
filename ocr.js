/* =========================================================================
   ocr.js — 扫描件 OCR
   -------------------------------------------------------------------------
   三层结构：
     1. 抽取  从扫描版 PDF 里把每页的整页图片抠出来
              （DCTDecode=JPEG 直接用 / FlateDecode=裸像素 / CCITTFaxDecode=传真压缩）
     2. 预处理 缩放、灰度、提对比 —— 这一步对识别率的影响比换引擎还大
     3. 识别   视觉大模型（质量最好）或 Tesseract.js（本地跑，但要下模型）

   设计约束：
     · 这个文件不依赖 app.js 的任何全局变量，API 配置由调用方传入
     · 纯函数（CCITT 解码、法语后处理）在 Node 里可直接跑，方便测试
   ========================================================================= */
(function (global) {
  'use strict';
  const IS_NODE = typeof module !== 'undefined' && !!module.exports;

  /* ==================== 基础工具 ==================== */

  function latin1(u8) {
    let s = '';
    const CH = 32768;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return s;
  }

  function toBase64(u8) {
    let s = '';
    const CH = 32768;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return global.btoa ? global.btoa(s) : Buffer.from(u8).toString('base64');
  }

  async function inflateBytes(bytes) {
    // 浏览器：原生 DecompressionStream
    if (typeof global.DecompressionStream === 'function') {
      for (const fmt of ['deflate', 'deflate-raw']) {
        try {
          const ds = new global.DecompressionStream(fmt);
          const w = ds.writable.getWriter();
          w.write(bytes); w.close();
          const chunks = [];
          const reader = ds.readable.getReader();
          for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
          const total = chunks.reduce((n, c) => n + c.length, 0);
          if (!total) continue;
          const out = new Uint8Array(total);
          let o = 0; chunks.forEach(c => { out.set(c, o); o += c.length; });
          return out;
        } catch (e) { /* 换下一种格式重试 */ }
      }
    }
    // Node：zlib
    try {
      const z = require('zlib');
      try { return new Uint8Array(z.inflateSync(Buffer.from(bytes))); } catch (e) { /* raw */ }
      try { return new Uint8Array(z.inflateRawSync(Buffer.from(bytes))); } catch (e) { /* 放弃 */ }
    } catch (e) { /* 无 zlib */ }
    throw new Error('当前环境不支持解压 PDF 数据流');
  }

  /* ==================== PDF 对象表 ==================== */

  // 建 num -> body 的表。扫描件的图片流是二进制，必须保证 latin1 是 1:1 字节映射，
  // 绝不能用 TextDecoder('latin1')（那是 windows-1252 的别名，会吃掉 0x80–0x9F）
  function buildObjTable(raw) {
    const objs = new Map();
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m, marks = [];
    while ((m = re.exec(raw)) !== null) marks.push({ n: +m[1], s: m.index + m[0].length });
    marks.forEach((mk, i) => {
      const end = raw.indexOf('endobj', mk.s);
      const stop = (i + 1 < marks.length && end < 0) ? marks[i + 1].s : end;
      objs.set(mk.n, raw.slice(mk.s, stop < 0 ? mk.s + 200 : stop));
    });
    return objs;
  }

  // 对象流（PDF 1.5+）：很多现代工具会把对象打包进 /ObjStm 压缩流里，
  // 直接扫「N 0 obj」会一个都找不到。必须先把它们摊平回对象表。
  async function expandObjectStreams(objs) {
    for (const [num, body] of Array.from(objs)) {
      if (!/\/ObjStm/.test(body)) continue;
      const first = numAfter(body, '/First', 0);
      const raw = streamBytes(body);
      if (!raw || !first) continue;
      let data;
      try { data = await inflateBytes(raw); } catch (e) { continue; }
      const head = latin1(data.subarray(0, Math.min(first, data.length)));
      const pairs = (head.match(/(\d+)\s+(\d+)/g) || []).map(s => s.split(/\s+/).map(Number));
      for (let i = 0; i < pairs.length; i++) {
        const [onum, off] = pairs[i];
        const end = i + 1 < pairs.length ? pairs[i + 1][1] : data.length - first;
        objs.set(onum, latin1(data.subarray(first + off, first + end)));
      }
      void num;
    }
    return objs;
  }

  function dictVal(body, key) {
    const i = body.indexOf(key);
    if (i < 0) return null;
    return body.slice(i + key.length, i + key.length + 80);
  }

  function numAfter(body, key, dflt) {
    const v = dictVal(body, key);
    if (!v) return dflt;
    const m = v.match(/^\s*(-?\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : dflt;
  }

  function refAfter(body, key) {
    const v = dictVal(body, key);
    if (!v) return null;
    const m = v.match(/^\s*(\d+)\s+\d+\s+R/);
    return m ? +m[1] : null;
  }

  // 取对象流里的原始字节
  function streamBytes(body) {
    const si = body.indexOf('stream');
    if (si < 0) return null;
    let ds = si + 6;
    if (body[ds] === '\r') ds++;
    if (body[ds] === '\n') ds++;
    const lenM = body.match(/\/Length\s+(\d+)/);
    let end;
    if (lenM) end = Math.min(body.length, ds + (+lenM[1]));
    else end = body.indexOf('endstream', ds);
    if (end < 0 || end > body.length) end = body.length;
    const slice = body.slice(ds, end);
    return Uint8Array.from(slice, c => c.charCodeAt(0) & 0xff);
  }

  /* ==================== CCITT G3/G4 传真解码 ====================
     黑白扫描件最爱用这套压缩（ABBYY / 老扫描仪 / 传真）。浏览器没有原生
     解码器，所以只能自己写。表是 ITU-T T.6 标准码表。 */

  const WHITE_TERM = [
    '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111',
    '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
    '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100',
    '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
    '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000',
    '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
    '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000',
    '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100'
  ];
  const BLACK_TERM = [
    '0000110111', '010', '11', '10', '011', '0011', '0010', '00011',
    '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000',
    '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000',
    '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001',
    '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111',
    '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
    '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111',
    '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111'
  ];
  const WHITE_MAKE = [
    '11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101',
    '01101000', '01100111', '011001100', '011001101', '011010010', '011010011',
    '011010100', '011010101', '011010110', '011010111', '011011000', '011011001',
    '011011010', '011011011', '010011000', '010011001', '010011010', '011000', '010011011'
  ];
  const BLACK_MAKE = [
    '0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100',
    '000000110101', '0000001101100', '0000001101101', '0000001001010', '0000001001011',
    '0000001001100', '0000001001101', '0000001110010', '0000001110011', '0000001110100',
    '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011',
    '0000001010100', '0000001010101', '0000001011010', '0000001011011', '0000001100100', '0000001100101'
  ];

  // 把码表编成「码字 -> {len, color, run}」的查找表（黑/白分开）
  function buildRunTable(term, make) {
    const tbl = new Map();
    let bad = [];
    term.forEach((c, i) => { if (tbl.has(c)) bad.push(c); tbl.set(c, i); });
    make.forEach((c, k) => { if (tbl.has(c)) bad.push(c); tbl.set(c, (k + 1) * 64); });
    return { tbl, bad };
  }
  const RUN_TABLES = { white: buildRunTable(WHITE_TERM, WHITE_MAKE), black: buildRunTable(BLACK_TERM, BLACK_MAKE) };

  // 前缀码必须无前缀，否则解码会错位。表里任一处抄错，这里几乎必炸
  function codesArePrefixFree(codes) {
    const set = new Set(codes);
    for (const c of codes) {
      for (let i = 1; i < c.length; i++) {
        if (set.has(c.slice(0, i))) return { ok: false, a: c, b: c.slice(0, i) };
      }
    }
    return { ok: true };
  }

  class BitReader {
    constructor(bytes) { this.b = bytes; this.pos = 0; }
    bit() {
      const byte = this.b[this.pos >> 3];
      if (byte === undefined) return -1;
      const v = (byte >> (7 - (this.pos & 7))) & 1;
      this.pos++;
      return v;
    }
    peek(n) {
      const save = this.pos;
      let s = '';
      for (let i = 0; i < n; i++) { const v = this.bit(); if (v < 0) break; s += v; }
      this.pos = save;
      return s;
    }
    remaining() { return Math.max(0, this.b.length * 8 - this.pos); }
  }

  // 读一个游程（MH 编码）：先读终止码，若 >= 64 继续读补充码累加
  function readRun(br, color) {
    const T = RUN_TABLES[color];
    let acc = 0, code = '';
    for (let guard = 0; guard < 40; guard++) {
      code += br.bit();
      if (br.pos > br.b.length * 8) return -1;
      if (T.tbl.has(code)) {
        const v = T.tbl.get(code);
        acc += v;
        if (v < 64) return acc;
        code = '';
      }
    }
    return -1;
  }

  /**
   * CCITT 解码
   * @param {Uint8Array} data 压缩后的字节
   * @param {number} width  图像宽（Columns）
   * @param {number} height 图像高（Rows）
   * @param {object} o      {K: -1 表示 G4 二维；0 表示 G3 一维；blackIs1: 1 是否表示黑}
   * @returns {Uint8Array} 每像素 0/1（1 表示黑，已按 blackIs1 归一化）
   */
  function ccittDecode(data, width, height, o) {
    o = o || {};
    const K = (o.K === undefined ? -1 : o.K);
    const br = new BitReader(data);
    const rows = Math.max(1, height | 0);
    const out = new Uint8Array(width * rows);
    let ref = new Uint8Array(width);           // G4 参考行：首行为全白
    const EOFB = '000000000001000000000001';

    // 参考行的所有变化点（升序）。G4 每步都要查 b1/b2，预先算好避免每行重复扫
    let refChg = [];
    const refreshRef = line => {
      refChg = [];
      let prev = 0;
      for (let i = 0; i < width; i++) if (line[i] !== prev) { refChg.push(i); prev = line[i]; }
    };
    const firstAfter = (arr, pos, cond) => {
      for (let i = 0; i < arr.length; i++) if (arr[i] > pos && (!cond || cond(arr[i]))) return arr[i];
      return width;
    };

    // 约定（T.6）：变化点 a_i 到 a_{i+1} 之间的游程占像素 [a_i, a_{i+1}-1]
    const fill = (line, from, to, color) => {
      const s = Math.max(from, 0), e = Math.min(to, width);
      for (let i = s; i < e; i++) line[i] = color;
    };

    for (let y = 0; y < rows; y++) {
      const cur = out.subarray(y * width, (y + 1) * width);

      if (K < 0) {
        // ---- G4（T.6，二维 MMR）：行首没有 EOL，靠 EOFB 结束 ----
        if (br.remaining() < 2) break;
        if (br.peek(24) === EOFB) break;
      } else {
        // ---- G3（MH）：每行前可能补 0 对齐，然后是 EOL 000000000001 ----
        let guard = 0;
        let b = 0;
        do { b = br.bit(); } while (b === 0 && guard++ < 200000);
        if (b !== 1) break;                    // 数据读完了
      }

      if (K === 0) {
        // 一维：黑白交替的游程序列
        let x = 0, color = 0;
        while (x < width) {
          const run = readRun(br, color ? 'black' : 'white');
          if (run < 0) break;
          fill(cur, x, x + run, color);
          x += run; color = color ? 0 : 1;
        }
      } else {
        // 二维 MMR
        refreshRef(ref);
        // a0 = 编码行上「已处理的最后一个变化点」。规范里行首 a0 取 -1，即第一个像素之前
        // 那个虚拟变化点 —— 这个 -1 很关键：若取 0，则「本行以黑像素开头」时位置 0 的变化点
        // 会被 b1 的「> a0」条件漏掉，整行黑白颠倒。
        // 但填充和游程长度要以 base = max(a0, 0) 为基准（虚拟点不占像素）。
        let a0 = -1, color = 0;
        let guard = 0;
        while (a0 < width && guard++ < width * 4 + 200) {
          const base = a0 < 0 ? 0 : a0;
          const b1 = firstAfter(refChg, a0, p => ref[p] !== color);
          const b2 = b1 >= width ? width : firstAfter(refChg, b1, null);
          const m = br.peek(7);
          let a1;

          if (m.slice(0, 4) === '0001') {          // Pass：跳过参考行上的整段
            br.pos += 4;
            a0 = b2;
            continue;
          }
          if (m.slice(0, 3) === '001') {           // Horizontal：直接给两个游程长度
            br.pos += 3;
            const r1 = readRun(br, color ? 'black' : 'white');
            const r2 = readRun(br, color ? 'white' : 'black');
            if (r1 < 0 || r2 < 0) break;
            const a1h = Math.min(base + r1, width);
            const a2h = Math.min(a1h + r2, width);
            fill(cur, base, a1h, color);
            fill(cur, a1h, a2h, color ? 0 : 1);
            a0 = a2h;
            continue;
          }
          if (m[0] === '1') { br.pos += 1; a1 = b1; }                          // V0
          else if (m.slice(0, 3) === '011') { br.pos += 3; a1 = b1 + 1; }      // VR1
          else if (m.slice(0, 6) === '000011') { br.pos += 6; a1 = b1 + 2; }   // VR2
          else if (m.slice(0, 7) === '0000011') { br.pos += 7; a1 = b1 + 3; }  // VR3
          else if (m.slice(0, 3) === '010') { br.pos += 3; a1 = b1 - 1; }      // VL1
          else if (m.slice(0, 6) === '000010') { br.pos += 6; a1 = b1 - 2; }   // VL2
          else if (m.slice(0, 7) === '0000010') { br.pos += 7; a1 = b1 - 3; }  // VL3
          else if (m.slice(0, 7) === '0000001') { br.pos += 7; break; }        // 扩展：不支持
          else break;

          a1 = Math.max(base, Math.min(a1, width));
          fill(cur, base, a1, color);
          a0 = a1;
          color = color ? 0 : 1;
        }
        fill(cur, a0 < 0 ? 0 : a0, width, color);   // 行尾补满
      }
      ref = cur;
    }

    if (o.invert) { for (let i = 0; i < out.length; i++) out[i] = out[i] ? 0 : 1; return out; }
    if (o.autoInvert === false) return out;
    // 兜底：文档页几乎不可能是「黑多于白」。真出现多半是我们对某个 flag 理解反了
    let black = 0;
    for (let i = 0; i < out.length; i++) black += out[i];
    if (black * 2 > out.length) { for (let i = 0; i < out.length; i++) out[i] = out[i] ? 0 : 1; }
    return out;
  }

  /* ==================== 从 PDF 抽页面图片 ==================== */

  function parseColorSpace(body, objs) {
    const m = body.match(/\/ColorSpace\s*(\/\w+|\d+\s+\d+\s+R)/);
    if (!m) return 'DeviceRGB';
    let v = m[1];
    const ref = v.match(/^(\d+)\s+\d+\s+R/);
    if (ref) {
      const b = objs.get(+ref[1]) || '';
      if (/\/ICCBased/.test(b)) {
        const n = (b.match(/\/N\s+(\d+)/) || [])[1];
        return n === '1' ? 'Gray' : (n === '4' ? 'CMYK' : 'RGB');
      }
      if (/\/Indexed/.test(b)) return 'Indexed';
      return 'RGB';
    }
    if (/DeviceGray|G$/.test(v)) return 'Gray';
    if (/DeviceCMYK/.test(v)) return 'CMYK';
    return 'RGB';
  }

  async function decodeImageXObject(body, objs) {
    if (/\/ImageMask\s+true/.test(body)) return null;   // 蒙版不是图
    const width = numAfter(body, '/Width', 0);
    const height = numAfter(body, '/Height', 0);
    const bpc = numAfter(body, '/BitsPerComponent', 8);
    if (!width || !height) return null;

    const filters = (body.match(/\/Filter\s*\[([^\]]*)\]/) || body.match(/\/Filter\s*(\/\w+)/) || [])[1]
      || (body.match(/\/Filter\s*(\/\w+)/) || [])[1] || '';
    const F = String(filters);
    const dpM = body.match(/\/DecodeParms\s*(\d+\s+\d+\s+R|<<[\s\S]*?>>)/);
    let dpBody = dpM ? dpM[1] : '';
    if (/^\d+\s+\d+\s+R/.test(dpBody)) dpBody = objs.get(+dpBody.match(/^(\d+)/)[1]) || '';

    const raw = streamBytes(body);
    if (!raw || !raw.length) return null;

    const cs = parseColorSpace(body, objs);
    const comps = cs === 'Gray' ? 1 : (cs === 'CMYK' ? 4 : 3);

    // ---- JPEG：绝大多数扫描件走这条路，字节可以直接当 .jpg 用 ----
    if (/DCTDecode/.test(F) && raw[0] === 0xff && raw[1] === 0xd8) {
      return { kind: 'jpeg', width, height, bytes: raw, mime: 'image/jpeg' };
    }
    // ---- JPEG2000：浏览器解不了，只能让用户重导 ----
    if (/JPXDecode/.test(F) || (raw[0] === 0x00 && raw[4] === 0x6a && raw[5] === 0x50)) {
      return { kind: 'unsupported', width, height, reason: 'JPXDecode（JPEG 2000）' };
    }
    // ---- 传真压缩 ----
    if (/CCITTFaxDecode/.test(F)) {
      const K = (dpBody.match(/\/K\s+(-?\d+)/) || [])[1];
      const invert = /\/Decode\s*\[\s*1\s+0\s*\]/.test(body) || /\/Decode\s*\[\s*1\s+0\s*\]/.test(dpBody);
      try {
        const bits = ccittDecode(raw, width, height, { K: K === undefined ? -1 : +K, invert });
        return { kind: 'bitmap', width, height, bits };
      } catch (e) {
        return { kind: 'unsupported', width, height, reason: 'CCITT 解码失败：' + e.message };
      }
    }
    // ---- Flate：裸像素，可能带 PNG 预测器 ----
    const flat = /FlateDecode/.test(F) || (!F && raw[0] === 0x78);
    if (flat) {
      let data;
      try { data = await inflateBytes(raw); }
      catch (e) { return { kind: 'unsupported', width, height, reason: 'FlateDecode 解压失败' }; }
      const predictor = (dpBody.match(/\/Predictor\s+(\d+)/) || [])[1];
      if (predictor && +predictor >= 10) {
        const bpp = Math.max(1, Math.ceil(bpc * comps / 8));
        data = unpredict(data, width, height, bpp);
      }
      return { kind: 'pixels', width, height, bpc, comps, data, colorSpace: cs };
    }
    // ---- 无压缩 ----
    if (!F) return { kind: 'pixels', width, height, bpc, comps, data: raw, colorSpace: cs };
    return { kind: 'unsupported', width, height, reason: F.replace(/\//g, '') };
  }

  // PNG 预测器还原（PDF 里和 PNG 是同一套 Filter 类型 0–4）
  function unpredict(data, width, height, bpp) {
    const stride = width * bpp;
    const out = new Uint8Array(stride * height);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
      const ft = data[y * (stride + 1)];
      const src = y * (stride + 1) + 1;
      const dst = y * stride;
      for (let x = 0; x < stride; x++) {
        const rawV = data[src + x] || 0;
        const a = x >= bpp ? out[dst + x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v;
        switch (ft) {
          case 0: v = rawV; break;
          case 1: v = rawV + a; break;
          case 2: v = rawV + b; break;
          case 3: v = rawV + ((a + b) >> 1); break;
          case 4: {
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            v = rawV + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
            break;
          }
          default: v = rawV;
        }
        out[dst + x] = v & 0xff;
      }
      prev = out.subarray(dst, dst + stride);
    }
    return out;
  }

  function resourcesOf(pageBody, objs) {
    let b = pageBody, depth = 0;
    while (b && depth++ < 8) {
      if (/\/Resources/.test(b)) {
        const r = refAfter(b, '/Resources');
        if (r !== null) { b = objs.get(r) || ''; continue; }
        if (/\/Resources\s*<</.test(b)) return b;
      }
      const p = refAfter(b, '/Parent');
      if (p === null) return null;
      b = objs.get(p) || '';
    }
    return null;
  }

  /**
   * 从扫描版 PDF 里抽出每页的整页图片
   * @returns {Promise<{pages:Array, unsupported:Array, pageCount:number}>}
   *          pages[i] = {page, kind, width, height, ...}  kind: jpeg|bitmap|pixels|unsupported
   */
  async function extractPageImages(bytes, onProgress) {
    const prog = onProgress || (() => { });
    const view = (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes))
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
    const raw = latin1(view);
    if (!/%PDF-/.test(raw.slice(0, 1024))) throw new Error('这不是一个 PDF 文件');

    const objs = await expandObjectStreams(buildObjTable(raw));
    const pageNums = [];
    objs.forEach((b, n) => { if (/\/Type\s*\/Page\b/.test(b) && !/\/Pages\b/.test(b)) pageNums.push(n); });
    pageNums.sort((a, b) => a - b);
    if (!pageNums.length) throw new Error('没找到任何页面对象');

    const pages = [], unsupported = [];
    for (let i = 0; i < pageNums.length; i++) {
      prog(Math.round(i / pageNums.length * 100), `抽取第 ${i + 1}/${pageNums.length} 页图片`);
      const res = resourcesOf(objs.get(pageNums[i]), objs);
      if (!res) continue;
      const xSeg = res.slice(res.indexOf('/XObject'));
      if (!/\/XObject/.test(res)) continue;
      let xBody = xSeg;
      const xr = refAfter(res, '/XObject');
      if (xr !== null) xBody = objs.get(xr) || '';
      const names = [];
      const rr = /(\/[\w#.\-]+)\s+(\d+)\s+\d+\s+R/g;
      let m;
      while ((m = rr.exec(xBody)) !== null) names.push(+m[2]);

      let best = null;
      for (const n of names) {
        const b = objs.get(n);
        if (!b || !/\/Subtype\s*\/Image/.test(b)) continue;
        const img = await decodeImageXObject(b, objs);
        if (!img) continue;
        img.page = i + 1;
        const area = img.width * img.height;
        if (!best || area > best.width * best.height) best = img;
      }
      if (!best) continue;
      if (best.kind === 'unsupported') unsupported.push(best);
      else pages.push(best);
    }
    return { pages, unsupported, pageCount: pageNums.length };
  }

  /* ==================== 预处理（浏览器） ==================== */

  async function loadBitmap(src) {
    if (typeof global.createImageBitmap === 'function') {
      try { return await global.createImageBitmap(src); } catch (e) { /* 回退到 Image */ }
    }
    // 回退路径必须带超时：某些环境（含老浏览器、无 canvas 的 DOM 模拟）既不给 onload
    // 也不给 onerror，会永久挂起，整个识别流程就卡死了。
    let url = src, made = false;
    try {
      const isBlob = (typeof Blob !== 'undefined' && src instanceof Blob)
        || (global.Blob && src instanceof global.Blob);
      if (isBlob && global.URL && global.URL.createObjectURL) { url = global.URL.createObjectURL(src); made = true; }
    } catch (e) { /* 保持原值 */ }
    return await new Promise((res, rej) => {
      const im = new global.Image();
      const timer = setTimeout(() => rej(new Error('图片解码超时')), 8000);
      const done = fn => () => {
        clearTimeout(timer);
        if (made && global.URL && global.URL.revokeObjectURL) { try { global.URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ } }
        fn();
      };
      im.onload = done(() => res(im));
      im.onerror = done(() => rej(new Error('图片解码失败')));
      im.src = url;
    });
  }

  /**
   * 缩放 + 灰度 + 提对比。OCR 对「字符高度 30–45 px」最敏感，
   * 扫描件常见 150 dpi 的 A4 大约是 1240x1754，放大到 2000 宽收益明显。
   */
  async function preprocess(source, opts) {
    opts = opts || {};
    const targetW = opts.targetWidth || 2000;
    const gray = opts.grayscale !== false;
    const contrast = opts.contrast || 1.25;

    const bmp = await loadBitmap(source);
    const w0 = bmp.width || source.width, h0 = bmp.height || source.height;
    let scale = 1;
    if (Math.max(w0, h0) < targetW * 0.75) scale = targetW / Math.max(w0, h0, 1);
    else if (Math.max(w0, h0) > 3600) scale = 3600 / Math.max(w0, h0);
    const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));

    const cv = global.document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);

    if (gray || contrast !== 1) {
      const id = ctx.getImageData(0, 0, w, h);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i], g = d[i + 1], b = d[i + 2];
        if (gray) { const y = (r * 0.299 + g * 0.587 + b * 0.114); r = g = b = y; }
        if (contrast !== 1) {
          r = (r - 128) * contrast + 128; g = (g - 128) * contrast + 128; b = (b - 128) * contrast + 128;
        }
        d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
        d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
      ctx.putImageData(id, 0, 0);
    }
    if (bmp.close) bmp.close();
    return await new Promise(res => cv.toBlob(res, 'image/png'));
  }

  // 位图（CCITT 解出来的 0/1）→ PNG Blob
  async function bitmapToBlob(bits, width, height) {
    const cv = global.document.createElement('canvas');
    cv.width = width; cv.height = height;
    const ctx = cv.getContext('2d');
    const id = ctx.createImageData(width, height);
    const d = id.data;
    for (let i = 0; i < width * height; i++) {
      const v = bits[i] ? 0 : 255;   // 1=黑
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return await new Promise(res => cv.toBlob(res, 'image/png'));
  }

  // 裸像素（Flate 解出来的 RGB/Gray/CMYK）→ PNG Blob
  async function pixelsToBlob(img) {
    const { width, height, bpc, comps, data, colorSpace } = img;
    const cv = global.document.createElement('canvas');
    cv.width = width; cv.height = height;
    const ctx = cv.getContext('2d');
    const id = ctx.createImageData(width, height);
    const d = id.data;
    const n = width * height;
    if (bpc === 8) {
      for (let i = 0; i < n; i++) {
        const o = i * comps;
        if (comps >= 3) {
          if (colorSpace === 'CMYK') {
            const c = data[o] / 255, m = data[o + 1] / 255, y = data[o + 2] / 255, k = data[o + 3] / 255;
            d[i * 4] = 255 * (1 - c) * (1 - k); d[i * 4 + 1] = 255 * (1 - m) * (1 - k); d[i * 4 + 2] = 255 * (1 - y) * (1 - k);
          } else { d[i * 4] = data[o]; d[i * 4 + 1] = data[o + 1]; d[i * 4 + 2] = data[o + 2]; }
        } else { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = data[o]; }
        d[i * 4 + 3] = 255;
      }
    } else if (bpc === 1) {
      for (let i = 0; i < n; i++) {
        const byte = data[i >> 3] || 0;
        const v = ((byte >> (7 - (i & 7))) & 1) ? 0 : 255;
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
    return await new Promise(res => cv.toBlob(res, 'image/png'));
  }

  /* ==================== 识别后端 ==================== */

  const VISION_PROMPT = `Transcris exactement le texte français de cette page.
Règles strictes :
- Conserve TOUS les accents et cédilles (é è ê ë à â î ï ô û ù ç œ æ) : ils changent le sens en français.
- Conserve les apostrophes typographiques (') telles quelles.
- Conserve les retours à la ligne et la structure des paragraphes.
- Ne traduis pas, ne commente pas, n'ajoute aucun titre ni explication.
- Si la page est vide ou illisible, réponds uniquement : [VIDE]
Réponds uniquement avec le texte transcrit.`;

  async function ocrByVision(blob, opts) {
    const api = opts.api;
    if (!api || (!api.key && !api.shared)) throw new Error('未配置 API Key');
    const b64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
    const mime = blob.type || 'image/png';
    const model = opts.model || api.model || (api.provider === 'claude' ? 'claude-opus-4-6' : 'gpt-4o');

    if (api.provider === 'claude') {
      const base = (api.base || 'https://api.anthropic.com').replace(/\/$/, '');
      const r = await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-api-key': api.key,
          'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model, max_tokens: 4000,
          messages: [{
            role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
              { type: 'text', text: VISION_PROMPT }
            ]
          }]
        })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const j = await r.json();
      return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    }
    const base = (api.base || 'https://api.openai.com/v1').replace(/\/$/, '');
    const h = { 'content-type': 'application/json' };
    if (!api.shared) h.authorization = 'Bearer ' + api.key;   // 共享代理由服务端带 Key
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        model, max_tokens: 4000,
        messages: [{
          role: 'user', content: [
            { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } },
            { type: 'text', text: VISION_PROMPT }
          ]
        }]
      })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  }

  const TESS_CDNS = [
    'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
    'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js'
  ];

  function loadScript(url) {
    return new Promise((res, rej) => {
      const s = global.document.createElement('script');
      s.src = url;
      s.onload = res;
      s.onerror = () => rej(new Error('无法加载 ' + url));
      global.document.head.appendChild(s);
    });
  }

  let tessWorker = null;
  async function getTesseract(opts, onProgress) {
    if (tessWorker) return tessWorker;
    if (!global.Tesseract) {
      let lastErr;
      for (const url of TESS_CDNS) {
        try {
          if (onProgress) onProgress(0, '下载识别引擎…');
          await loadScript(url);
          if (global.Tesseract) break;
        } catch (e) { lastErr = e; }
      }
      if (!global.Tesseract) throw new Error('识别引擎下载失败（可能没有网络，或 CDN 被墙）。' + (lastErr ? ' ' + lastErr.message : ''));
    }
    const o = { logger: m => { if (onProgress && m.status) onProgress(Math.round((m.progress || 0) * 100), m.status); } };
    if (opts.langPath) o.langPath = opts.langPath;
    tessWorker = await global.Tesseract.createWorker(opts.lang || 'fra', 1, o);
    return tessWorker;
  }

  async function ocrByTesseract(blob, opts) {
    const w = await getTesseract(opts, opts.onProgress);
    const { data } = await w.recognize(blob);
    return data && data.text ? data.text : '';
  }

  async function terminateTesseract() {
    if (tessWorker) { try { await tessWorker.terminate(); } catch (e) { /* 忽略 */ } tessWorker = null; }
  }

  /* ==================== 法语后处理 ==================== */

  // OCR 的典型错误里，只有「结构性」的那部分是安全可修的。
  // 像 é→e 这种丢音符，没有上下文词典就不敢乱加——法语里 et/était 差一个音符就是两个词。
  function frenchCorrect(text) {
    if (!text) return '';
    let t = String(text);
    t = t.replace(/\r\n?/g, '\n');
    t = t.replace(/[‘’ʼ′`´]/g, "'").replace(/[“”„]/g, '"');
    t = t.replace(/[‐‑‒–—]/g, '-');
    t = t.replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬀ/g, 'ff').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl');
    t = t.replace(/­/g, '');
    // 行尾断词：architec-\nture → architecture
    t = t.replace(/([A-Za-zÀ-ÿ])-[ \t]*\n+[ \t]*(?=[a-zà-ÿ])/g, '$1');
    // 被换行甩到下一行的标点
    t = t.replace(/([A-Za-zÀ-ÿ0-9»”’)])\n+([.,;:!?»”)])/g, '$1$2');
    t = t.replace(/([,;])\n+(?=[a-zà-ÿ])/g, '$1 ');
    // 孤立的单字母行多半是噪点
    t = t.replace(/\n[|~*#_•·]{1,3}\n/g, '\n');
    t = t.replace(/[ \t]+\n/g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n');
    t = t.replace(/[ \t]{2,}/g, ' ');
    return t.trim();
  }

  // 给个粗判：识别结果像不像法语。用来提示用户「这页可能识别歪了」
  const FR_HINT = /\b(le|la|les|de|des|un|une|et|est|dans|pour|avec|sur|que|qui|nous|vous|ils|elle|au|aux|du|ce|cette|mais|ou|où|ne|pas|plus|très|être|avoir|faire)\b/i;
  function qualityOf(text) {
    const words = (text.match(/[A-Za-zÀ-ÿ]{2,}/g) || []);
    const n = words.length;
    if (!n) return { level: 'empty', note: '没识别出文字' };
    const fr = words.filter(w => FR_HINT.test(w)).length;
    const accented = (text.match(/[éèêëàâîïôûùçœæÉÈÊËÀÂÎÏÔÛÙÇŒÆ]/g) || []).length;
    const ratio = fr / n;
    if (n < 8) return { level: 'low', note: '只识别到很少的文字，这页可能是插图或空白页' };
    if (ratio < 0.06 && accented < 3) return { level: 'low', note: '识别结果里几乎没有法语特征词，可能整页识别失败' };
    return { level: 'ok', note: `${n} 词，含 ${accented} 个带音符字符` };
  }

  /* ==================== 对外入口 ==================== */

  /**
   * 识别一批页面图片
   * @param {Array} pages extractPageImages 的结果（或 [{blob}]）
   * @param {object} opts {engine:'vision'|'tesseract', api, model, lang, langPath, maxPages, onProgress}
   */
  async function recognizeImages(pages, opts) {
    const prog = opts.onProgress || (() => { });
    const use = pages.slice(0, opts.maxPages || pages.length);
    const out = [];
    let fail = 0;
    for (let i = 0; i < use.length; i++) {
      const p = use[i];
      prog(Math.round(i / use.length * 100), `识别第 ${i + 1}/${use.length} 页`);
      try {
        let blob = p.blob;
        if (!blob) {
          if (p.kind === 'jpeg') blob = new Blob([p.bytes], { type: 'image/jpeg' });
          else if (p.kind === 'bitmap') blob = await bitmapToBlob(p.bits, p.width, p.height);
          else if (p.kind === 'pixels') blob = await pixelsToBlob(p);
          else throw new Error('不支持的图片格式');
        }
        if (opts.preprocess !== false && typeof global.document !== 'undefined' && global.document.createElement) {
          try { blob = await preprocess(blob, opts); } catch (e) { /* 预处理失败就用原图 */ }
        }
        const raw = opts.engine === 'tesseract'
          ? await ocrByTesseract(blob, { lang: opts.lang, langPath: opts.langPath, onProgress: m => prog(0, '第 ' + (i + 1) + ' 页 · ' + m) })
          : await ocrByVision(blob, { api: opts.api, model: opts.model });
        const txt = frenchCorrect(raw);
        if (/^\[VIDE\]$/i.test(txt.trim())) { out.push({ page: p.page || i + 1, text: '', quality: 'empty' }); continue; }
        out.push({ page: p.page || i + 1, text: txt, quality: qualityOf(txt).level });
      } catch (e) {
        fail++;
        out.push({ page: p.page || i + 1, text: '', error: e.message, quality: 'error' });
        if (fail >= 3 && i > 0) {
          prog(100, '连续失败，已停止');
          break;
        }
      }
    }
    return { pages: out, failed: fail };
  }

  const OCR = {
    extractPageImages, recognizeImages, preprocess, bitmapToBlob, pixelsToBlob,
    ccittDecode, unpredict, frenchCorrect, qualityOf, toBase64, latin1,
    terminateTesseract, VISION_PROMPT,
    // 测试用：验证码表本身没抄错（前缀码必须无前缀，且不能有重复码字）
    _tables: { WHITE_TERM, BLACK_TERM, WHITE_MAKE, BLACK_MAKE, RUN_TABLES, codesArePrefixFree, buildObjTable }
  };

  if (IS_NODE) module.exports = OCR;
  if (typeof global !== 'undefined') global.OCR = OCR;
})(typeof window !== 'undefined' ? window : globalThis);
