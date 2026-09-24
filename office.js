/* Allez! — Office / 多格式文本抽取
   零依赖：zip 目录自己解、deflate 自己解压、XML 用正则取文本节点。
   新格式（docx / pptx / xlsx / odt / epub / rtf）是「zip + XML」或纯文本标记，能拿到干净正文；
   旧格式（doc / ppt 是 Word 97 / PowerPoint 97 的 OLE2 复合文档）没有公开的简洁解析路径，
   走「扫描可读文本序列」的尽力提取，能用但质量有限，所以会明确提示用户另存为新格式。 */
(function (root) {
  const IS_NODE = typeof module !== 'undefined' && !!module.exports;
  let _zlib = null;
  if (IS_NODE) { try { _zlib = require('zlib'); } catch (e) { /* 浏览器没有 zlib */ } }

  /* ---------- 基础工具 ---------- */
  function latin1(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 65536) s += String.fromCharCode.apply(null, u8.subarray(i, i + 65536));
    return s;
  }

  // OOXML / ODF 的 XML 一律是 UTF-8。这里千万别用 latin1 解码：
  // 那样 é 会变成 Ã©、中文会变成 ä¸­æ–‡，看起来像"抽出来了"其实是废文本。
  function utf8(u8) {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('utf8');
    }
    try { return new TextDecoder('utf-8').decode(u8); } catch (e) { return latin1(u8); }
  }

  // zip 用的是裸 deflate（没有 zlib 头），所以是 deflate-raw / inflateRawSync
  async function inflateRaw(bytes) {
    if (_zlib) return new Uint8Array(_zlib.inflateRawSync(Buffer.from(bytes)));
    if (typeof DecompressionStream === 'function') {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('当前浏览器不支持解压（需要 DecompressionStream）。请升级到较新的 Chrome / Edge / Safari 16.4+ / Firefox 113+。');
  }

  function unescXml(s) {
    return s.replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; } })
      .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(+d); } catch (e) { return m; } })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }

  // 取某标签内所有文本（支持同名标签嵌套的外层，比如 <a:p>…<a:t>x</a:t>…</a:p>）
  function tagText(xml, outer, inner) {
    const out = [];
    const parts = xml.split('</' + outer + '>');
    for (const p of parts) {
      const re = new RegExp('<' + inner + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + inner + '>', 'g');
      let m, buf = '';
      while ((m = re.exec(p)) !== null) buf += unescXml(m[1]);
      // 单标签形式 <a:t/> 表示空，忽略；<w:tab/> 给空格、<w:br/> 给换行
      if (/<w:tab\b/.test(p) || /<a:tab\b/.test(p)) buf = buf.replace(/()/g, ''); // tab 已在 XML 外处理
      const line = buf.replace(/\t/g, ' ').trim();
      if (line) out.push(line);
    }
    return out.join('\n');
  }

  /* ---------- zip ---------- */
  function parseZip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = bytes.length;
    let eocd = -1;
    const from = Math.max(0, n - 22 - 65535);
    for (let i = n - 22; i >= from; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('这个文件不是有效的 Office 文档（找不到 zip 目录，可能已损坏或受密码保护）');

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (p + 46 > n || dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      let name = latin1(bytes.subarray(p + 46, p + 46 + nlen));
      try { name = decodeURIComponent(escape(name)); } catch (e) { /* 非 UTF-8 就用 latin1 */ }
      entries.push({ name, method, csize, usize, lho });
      p += 46 + nlen + elen + clen;
    }
    return entries;
  }

  function entryData(bytes, e) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const nlen = dv.getUint16(e.lho + 26, true);
    const elen = dv.getUint16(e.lho + 28, true);
    const start = e.lho + 30 + nlen + elen;
    // 少数工具写出的 zip 中央目录里 csize=0（用 data descriptor），这时扫到下一个签名为止
    let end = start + (e.csize || e.usize || 0);
    if (!e.csize) {
      for (let i = start; i < bytes.length - 4; i++) {
        const sig = dv.getUint32(i, true);
        if (sig === 0x04034b50 || sig === 0x02014b50 || sig === 0x06054b50) { end = i; break; }
      }
    }
    return bytes.subarray(start, Math.min(end, bytes.length));
  }

  async function entryText(bytes, entries, name) {
    const e = entries.find(x => x.name === name || x.name.toLowerCase() === name.toLowerCase());
    if (!e) return '';
    const raw = entryData(bytes, e);
    if (e.method === 0) return utf8(raw);
    if (e.method === 8) { try { return utf8(await inflateRaw(raw)); } catch (err) { return ''; } }
    return '';   // 其它压缩算法（比如 Office 罕见的 LZMA）不处理
  }

  function namesLike(entries, re) {
    return entries.filter(e => re.test(e.name)).map(e => e.name);
  }

  // ppt/slides/slide2.xml → 2，保证幻灯片顺序正确（字符串排序会让 slide10 排到 slide2 前面）
  function naturalSort(a, b) {
    const pa = a.replace(/.*?(\d+)(?=\D*$)/, '$1'), pb = b.replace(/.*?(\d+)(?=\D*$)/, '$1');
    const na = parseInt(pa, 10), nb = parseInt(pb, 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  /* ---------- 各格式 ---------- */
  async function readDocx(bytes, entries) {
    const xml = await entryText(bytes, entries, 'word/document.xml');
    if (!xml) throw new Error('这个 .docx 里没有 word/document.xml，可能不是 Word 文档或已损坏');
    let text = tagText(xml, 'w:p', 'w:t');
    // 表格单元格：没有 w:p 包裹的孤立 w:t 会在上面被吃进上一段，这里再补一次按 w:tc 兜底
    if (text.trim().length < 40) text = tagText(xml, 'w:tc', 'w:t') || text;
    return { text, note: '' };
  }

  async function readPptx(bytes, entries) {
    const slides = namesLike(entries, /^ppt\/slides\/slide\d+\.xml$/).sort(naturalSort);
    if (!slides.length) throw new Error('这个 .pptx 里找不到幻灯片（ppt/slides/slideN.xml），可能已损坏');
    const chunks = [];
    for (const s of slides) {
      const xml = await entryText(bytes, entries, s);
      if (!xml) continue;
      const t = tagText(xml, 'a:p', 'a:t');
      if (t.trim()) chunks.push(t);
    }
    let text = chunks.join('\n\n');
    let note = `共 <b>${slides.length}</b> 张幻灯片`;
    // 正文太少时补上备注页（讲稿常常写在备注里）
    if (text.trim().length < 60) {
      const notes = namesLike(entries, /^ppt\/notesSlides\/notesSlide\d+\.xml$/).sort(naturalSort);
      const nc = [];
      for (const n of notes) {
        const xml = await entryText(bytes, entries, n);
        const t = xml ? tagText(xml.replace(/<a:t/g, '<a:t'), 'a:p', 'a:t') : '';
        if (t.trim()) nc.push(t);
      }
      if (nc.length) { text = nc.join('\n\n'); note += `（正文为空，已改用备注文本）`; }
    }
    return { text, note };
  }

  async function readXlsx(bytes, entries) {
    // 共享字符串：单元格里存的是下标，<v>0</v> 意思是"第 0 条共享字符串"，不是数字 0。
    // 不还原的话整张表会变成一堆 0 1 2 3。
    const shared = [];
    const ss = await entryText(bytes, entries, 'xl/sharedStrings.xml');
    if (ss) {
      const re = /<si>([\s\S]*?)<\/si>/g;
      let m;
      while ((m = re.exec(ss)) !== null) {
        const ts = [];
        const tre = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tre.exec(m[1])) !== null) ts.push(unescXml(t[1]));
        shared.push(ts.join(''));
      }
    }

    const rows = [];
    const sheets = namesLike(entries, /^xl\/worksheets\/sheet\d+\.xml$/).sort(naturalSort);
    for (const sh of sheets.slice(0, 20)) {
      const xml = await entryText(bytes, entries, sh);
      if (!xml) continue;
      const rowParts = xml.split('</row>');
      for (const r of rowParts) {
        const cells = [];
        const cellRe = /<c\b([^>]*?)>([\s\S]*?)<\/c>|<c\b([^>]*?)\/>/g;
        let c;
        while ((c = cellRe.exec(r)) !== null) {
          const attrs = c[1] || c[3] || '';
          const inner = c[2] || '';
          const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || '';
          if (type === 's') {
            const idx = +((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] || -1);
            if (idx >= 0 && shared[idx] !== undefined) cells.push(shared[idx]);
          } else {
            const t = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(inner);   // inlineStr
            const v = /<v>([\s\S]*?)<\/v>/.exec(inner);               // 数字 / 布尔
            const val = t ? unescXml(t[1]) : (v ? unescXml(v[1]) : '');
            if (String(val).trim()) cells.push(val);
          }
        }
        if (cells.length) rows.push(cells.join('\t'));
      }
    }

    let text = rows.join('\n');
    if (text.trim().length < 20 && shared.length) text = shared.filter(Boolean).join('\n');
    if (!text.trim()) throw new Error('这个 .xlsx 里没有可提取的文本');
    return { text, note: sheets.length ? `共 <b>${sheets.length}</b> 个工作表` : '' };
  }

  async function readOdt(bytes, entries) {
    const xml = await entryText(bytes, entries, 'content.xml');
    if (!xml) throw new Error('这个 .odt 里没有 content.xml');
    // <text:p> / <text:h> 是段落，里面的 <text:span> 只是样式，直接剥标签即可
    const text = xml.split(/<\/text:(?:p|h)>/).map(seg =>
      unescXml(seg.replace(/<[^>]+>/g, '')).trim()).filter(Boolean).join('\n');
    return { text, note: '' };
  }

  async function readEpub(bytes, entries) {
    const docs = entries.filter(e => /\.(x?html|htm)$/i.test(e.name))
      .filter(e => !/^(META-INF|OEBPS\/)?(toc|nav)\b/i.test(e.name))
      .map(e => e.name).sort(naturalSort).slice(0, 60);
    const chunks = [];
    for (const d of docs) {
      const html = await entryText(bytes, entries, d);
      if (!html) continue;
      const body = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
      const t = unescXml(body.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li)>/gi, '\n').replace(/<[^>]+>/g, ''))
        .replace(/[ \t]+/g, ' ').trim();
      if (t) chunks.push(t);
    }
    if (!chunks.length) throw new Error('这个 .epub 里没有可读章节');
    return { text: chunks.join('\n\n'), note: `共 <b>${chunks.length}</b> 个章节` };
  }

  // RTF 开头那一大堆 {\fonttbl…}、{\colortbl…}、{\stylesheet…} 不是正文，
  // 不整块删掉的话会抽出 "Helvetica-Light;" 之类的字体名挂在正文前面。
  function stripRtfBlocks(s) {
    const names = ['fonttbl', 'colortbl', 'stylesheet', 'info', 'listtable', 'listoverridetable',
      'revtbl', 'rsidtbl', 'generator', 'falt', 'fname', 'panose', 'docvar', 'mmathPr',
      'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'mmath', 'filetbl', 'pgdsctbl'];
    for (const nm of names) {
      const re = new RegExp('\\\\' + nm + '\\b');
      let m;
      let guard = 0;
      while ((m = re.exec(s)) !== null && guard++ < 40) {
        let i = m.index + m[0].length;
        while (i < s.length && /\s/.test(s[i])) i++;
        let end;
        if (s[i] === '{') {                    // 花括号组：数到配对为止
          let depth = 0;
          for (; i < s.length; i++) {
            if (s[i] === '{') depth++;
            else if (s[i] === '}') { depth--; if (depth === 0) { i++; break; } }
          }
          end = i;
        } else {                               // 无括号（如 \colortbl …;）：吃到分号
          end = s.indexOf(';', i);
          end = end < 0 ? s.length : end + 1;
        }
        s = s.slice(0, m.index) + ' ' + s.slice(end);
      }
    }
    return s;
  }

  function readRtf(bytes) {
    let s = latin1(bytes);
    if (!/^\s*\{?\s*\\rtf/.test(s)) throw new Error('这不是一个 RTF 文件');
    s = stripRtfBlocks(s);
    // \'hh 是单字节转义（通常是 cp1252 / latin1）
    s = s.replace(/\\'([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
    s = s.replace(/\\u(-?\d+)\??/g, (m, d) => { try { return String.fromCodePoint((+d + 65536) % 65536); } catch (e) { return ''; } });
    let text = s
      .replace(/\\[a-z]+-?\d* ?/g, ' ')     // 控制字 \b \fs20 \cf1 …
      .replace(/[{}]/g, '')
      .replace(/\\\*[^\s;]+;?/g, '')        // \*\falt 之类
      .replace(/\\par\b/g, '\n').replace(/\\line\b/g, '\n').replace(/\\tab\b/g, '\t')
      .replace(/\r?\n[ \t]+/g, '\n');
    // 去掉只留下 ; { } \ 这类残渣的行（样式表没清干净时的典型残留），并剃掉行尾多余的反斜杠
    text = text.split('\n')
      .map(l => l.replace(/[ \t]+/g, ' ').replace(/[\\]+$/, '').trim())
      .filter(l => l && /[A-Za-zÀ-ÿ]/.test(l))
      .join('\n');
    if (!text.trim()) throw new Error('这个 RTF 里没有可读文本');
    return { text, note: '' };
  }

  /* ---------- 旧版 doc / ppt：尽力扫描 ---------- */
  function okChar(code) {
    if (code >= 0x20 && code <= 0x7e) return true;          // ASCII 可打印
    if (code >= 0xa0 && code <= 0xff) return true;          // latin1 补充区（é è à ç œ 等）
    if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
    if (code >= 0x2013 && code <= 0x201d) return true;      // – — ‘ ’ “ ”
    if (code === 0x2026 || code === 0x2022 || code === 0x00b7) return true;
    return false;
  }

  // 扫出连续的可读字符序列，短于一串阈值就丢掉（二进制噪声通常是零星的）
  function scanReadable(bytes, wide) {
    const out = [];
    let buf = '';
    const step = wide ? 2 : 1;
    for (let i = 0; i + step - 1 < bytes.length; i += step) {
      const code = wide ? (bytes[i] | (bytes[i + 1] << 8)) : bytes[i];
      if (okChar(code)) {
        if (code === 0x0d || code === 0x0a) { if (buf.trim().length >= 2) { out.push(buf.trim()); } buf = ''; }
        else buf += String.fromCharCode(code);
      } else {
        if (buf.trim().length >= 2) out.push(buf.trim());
        buf = '';
      }
    }
    if (buf.trim().length >= 2) out.push(buf.trim());
    return out;
  }

  const JUNK_LINE = /^(?:[A-Za-z]{1,2}\d?|[\d.]+|Normal|Times New Roman|Arial|Symbol|Wingdings|Courier New|Calibri|Cambria|Helvetica|Verdana|Tahoma|Segoe UI|Microsoft|Office|Word|PowerPoint|Document|SummaryInformation|WordDocument|Root Entry|1Table|0Table|Data|ObjectPool|\\*[a-z]+)$/i;

  // 先把噪声滤掉再评分。顺序很重要：OLF 文件里成片的 0xFF 会被读成合法的 ÿ，
  // 而 ÿ 又落在 À-ÿ 里，于是"ÿÿÿÿ"看起来像是满篇法语字母，会把真正的正文挤掉。
  function cleanLines(lines) {
    return lines.filter(l => {
      const t = l.trim();
      if (t.length < 3 || JUNK_LINE.test(t)) return false;
      const letters = (t.match(/[A-Za-zÀ-ÿ]/g) || []).length;
      if (!letters) return false;
      if (letters / t.length < 0.45) return false;          // 字母太少多半是二进制残渣
      const cnt = Object.create(null);
      for (const ch of t) cnt[ch] = (cnt[ch] || 0) + 1;
      let top = 0;
      for (const k in cnt) if (cnt[k] > top) top = cnt[k];
      if (top / t.length > 0.5) return false;               // 同一个字符占一半以上 → 填充
      return true;
    });
  }

  function lettersOf(lines) {
    return lines.reduce((n, l) => n + (l.match(/[A-Za-zÀ-ÿ]/g) || []).length, 0);
  }

  function readLegacy(bytes) {
    if (!(bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)) {
      throw new Error('这不像一个 Word / PowerPoint 97-2003 文件（缺 OLE2 文件头）');
    }
    const single = cleanLines(scanReadable(bytes, false));
    const wide = cleanLines(scanReadable(bytes, true));
    // Word 97 多半是 8-bit（压缩）存储，PowerPoint 97 用 UTF-16；哪个滤完还剩得多就用哪个
    const best = lettersOf(wide) > lettersOf(single) ? wide : single;
    const text = best.join('\n');
    if (text.trim().length < 20) throw new Error('这个旧格式文件里没能提取出足够正文');
    return {
      text,
      note: `（旧格式提取，可能有少量错字；另存为 .docx / .pptx 会更准）`
    };
  }

  /* ---------- 格式识别 ---------- */
  function detect(bytes, name) {
    const ext = (name || '').toLowerCase().split('.').pop();
    const knownExt = { docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', odt: 'odt', epub: 'epub', rtf: 'rtf', doc: 'doc', ppt: 'ppt' };
    if (knownExt[ext]) return knownExt[ext];

    // 扩展名不可靠（用户改过名 / 没有扩展名）时看内容
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      try {
        const entries = parseZip(bytes);
        const has = n => entries.some(e => e.name === n || e.name.toLowerCase() === n);
        if (has('word/document.xml')) return 'docx';
        if (entries.some(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))) return 'pptx';
        if (has('xl/workbook.xml')) return 'xlsx';
        if (has('content.xml')) return 'odt';
        if (has('mimetype') || has('META-INF/container.xml')) return 'epub';
      } catch (e) { /* 不是标准 zip，继续按扩展名 / 二进制判断 */ }
    }
    if (/^\s*\{\s*\\rtf/.test(latin1(bytes.subarray(0, 64)))) return 'rtf';
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
      const head = latin1(bytes.subarray(0, Math.min(bytes.length, 4096)));
      const wide = scanReadable(bytes.subarray(0, Math.min(bytes.length, 8192)), true).join(' ');
      if (/PowerPoint/.test(wide) || /PowerPoint/.test(head)) return 'ppt';
      return 'doc';
    }
    return '';
  }

  /* ---------- 统一入口 ---------- */
  async function readFile(bytes, name, onProgress) {
    const prog = onProgress || (() => { });
    const kind = detect(bytes, name || '');
    prog(20, '识别格式…');

    if (kind === 'rtf') { prog(60, '解析 RTF…'); return Object.assign({ kind }, readRtf(bytes)); }

    if (kind === 'doc' || kind === 'ppt') {
      prog(60, '解析旧版 Office 文档…');
      return Object.assign({ kind }, readLegacy(bytes));
    }

    if (!kind) {
      throw new Error('认不出这是什么格式。目前支持：PDF、Word(.docx/.doc)、PowerPoint(.pptx/.ppt)、Excel(.xlsx)、'
        + 'OpenDocument(.odt)、EPUB、RTF、纯文本(.txt/.md/.csv) 和图片。');
    }

    prog(40, '读取压缩包…');
    const entries = parseZip(bytes);
    prog(70, '抽取文本…');
    let r;
    if (kind === 'docx') r = await readDocx(bytes, entries);
    else if (kind === 'pptx') r = await readPptx(bytes, entries);
    else if (kind === 'xlsx') r = await readXlsx(bytes, entries);
    else if (kind === 'odt') r = await readOdt(bytes, entries);
    else r = await readEpub(bytes, entries);
    prog(100, '完成');
    return Object.assign({ kind }, r);
  }

  const Office = { readFile, detect, parseZip, entryText, readRtf, readLegacy,
    _internal: { scanReadable, tagText, unescXml, naturalSort, inflateRaw } };

  if (IS_NODE) module.exports = Office;
  if (typeof global !== 'undefined') global.Office = Office;
  if (root) root.Office = Office;
})(typeof window !== 'undefined' ? window : globalThis);
