/* Allez! — 应用层 */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* ---- 站主可选部署的共享代理 ----
   留空字符串表示没部署，此时每个访客都得自己填 Key。
   部署后由 build.js 把下面两个占位符替换成真实值（读环境变量 ALLEZ_PROXY_BASE / _MODEL）。
   访客在这个模式下不需要 Key —— Key 藏在 Workers 的环境变量里。 */
const PROXY_BASE = '__ALLEZ_PROXY_BASE__';
const PROXY_MODEL = '__ALLEZ_PROXY_MODEL__';
const hasProxy = () => /^https?:\/\//.test(PROXY_BASE);

/* 到底能不能调用模型：免费公共 AI / 自己有 Key / 站主配了共享代理且访客选了它 */
function isFreeAI() { return S.api.preset === 'free' || S.api.provider === 'free'; }
function hasLLM() { return isFreeAI() || !!S.api.key || (hasProxy() && S.api.preset === 'proxy'); }

const DEFAULT_STATE = () => ({
  exam: 'B1', examDate: '', rawText: '',
  vocab: [], grammar: [], cards: [], mode: 'recognize',
  api: { provider: 'free', base: '', key: '', model: 'openai-fast', preset: 'free' },
  ocr: { engine: 'auto', model: '', langPath: '', maxPages: 20 },
  gloss: {},                       // 已经补过中文的词，跨材料复用，省得反复问模型
  autoZh: true,                    // 解析后自动补齐中文释义
  stats: { reviews: 0, correct: 0 }, done: {}
});

let S = loadState() || DEFAULT_STATE();
// 老版本存档没有 ocr 字段，补齐默认值，省得到处写判空
S.ocr = Object.assign({ engine: 'auto', model: '', langPath: '', maxPages: 20 }, S.ocr || {});
// 后加的字段同理：补过中文的词表、自动补释义开关、服务商预设
S.gloss = S.gloss || {};
if (S.autoZh === undefined) S.autoZh = true;
if (!S.api.preset) {
  S.api.preset = S.api.key ? 'custom' : (hasProxy() ? 'proxy' : 'free');
  if (S.api.preset === 'free') S.api.model = S.api.model || 'openai-fast';
}
let Q = null;               // 当前题目
let pendingCalibrate = false;

function save() { saveState(S); }

/* ---------------- 服务商预设 ----------------
   让用户自己填 Endpoint 是最劝退的一步。这里把常见服务商的地址和模型预置好，
   选完之后只需要粘一个 Key。免费额度情况写在 note 里，不吹不瞒。 */
const API_PRESETS = {
  free: {
    label: '免费公共 AI（什么都不用申请）',
    provider: 'free', base: '', model: 'openai-fast', vision: '', shared: false,
    models: [
      ['openai-fast', 'GPT 快速版（默认，响应快）'],
      ['openai-large', 'GPT 大模型（更准，稍慢）'],
      ['qwen', '通义千问（中法互译较稳）'],
      ['deepseek', 'DeepSeek'],
      ['llama', 'Llama'],
      ['mistral', 'Mistral']
    ],
    note: '<b>开箱即用：不用注册、不用填 Key，选好模型就能用。</b>' +
      '走的是公开免费的公益推理服务，速度快慢取决于对方当时的负载，' +
      '偶尔会连不上或变慢 —— 那是公共服务的正常波动，换一个模型通常就好了。<br>' +
      '<b>请注意：请求内容会经过第三方服务器</b>，所以不要提交证件、病历、未公开试卷这类敏感材料；' +
      '日常练习材料没问题。想要稳定、私密、更快，就在下面换成自己的 Key。'
  },
  proxy: {
    label: '站内额度（不用自己申请 Key）',
    provider: 'openai', base: PROXY_BASE, model: PROXY_MODEL, vision: PROXY_MODEL, shared: true,
    note: '<b>本站主人已经配好网络和 Key，选这项直接用。</b>住的请求会经过站主的代理转发，' +
      '所以请<b>不要提交证件、病历、未公开试卷这类敏感材料</b>；日常练习材料没问题。' +
      '有每日次数上限，用完了会提示你，届时可以在下面换成自己的 Key。'
  },
  zhipu: {
    label: '智谱 GLM（国内直连 · 有永久免费档）',
    provider: 'openai', base: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash', vision: 'glm-4v-flash',
    note: '<b>国内直连，注册送额度，GLM-4-Flash 长期免费。</b>注册地址 open.bigmodel.cn，控制台 → API Keys 里生成。' +
      '视觉模型名若报错（平台会调整），把下面「视觉模型」改成控制台里当前可用的免费视觉模型即可。'
  },
  siliconflow: {
    label: '硅基流动（国内 · 小模型永久免费）',
    provider: 'openai', base: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct', vision: 'Qwen/Qwen2.5-VL-32B-Instruct',
    note: '<b>9B 以下模型永久免费</b>，国内延迟低。注册 siliconflow.cn，控制台生成 Key。' +
      '注意：免费档只覆盖小模型，视觉模型（VL）通常要付费，OCR 建议改用 OpenRouter 的免费视觉模型。'
  },
  openrouter: {
    label: 'OpenRouter（免费视觉模型最多）',
    provider: 'openai', base: 'https://openrouter.ai/api/v1',
    model: 'openrouter/free', vision: 'baidu/qianfan-ocr-fast:free',
    note: '<b>一个 Key 通吃几百个模型，带 :free 后缀的不要钱。</b>注册 openrouter.ai 即送少量额度，免费模型另有每日限额。' +
      'OCR 默认用百度千帆的免费 OCR 专用模型；nvidia/nemotron-nano-12b-v2-vl:free 也很强，可以换着试。'
  },
  gemini: {
    label: 'Google Gemini（有免费额度）',
    provider: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash', vision: 'gemini-2.0-flash',
    note: '走 Google 官方的 OpenAI 兼容端点。免费额度足够个人用，但需要能访问 Google 服务。'
  },
  deepseek: {
    label: 'DeepSeek（国内 · 便宜）',
    provider: 'openai', base: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat', vision: '',
    note: '国内直连、价格低，但<b>没有视觉模型</b>，OCR 功能不可用。只想要中文释义和写作批改的话性价比很高。'
  },
  openai: {
    label: 'OpenAI 官方',
    provider: 'openai', base: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini', vision: 'gpt-4o-mini',
    note: '需要能访问 OpenAI 服务。gpt-4o-mini 价格很低，个人使用每月通常几块钱。'
  },
  claude: {
    label: 'Anthropic Claude',
    provider: 'claude', base: 'https://api.anthropic.com',
    model: 'claude-opus-4-6', vision: 'claude-opus-4-6',
    note: '法语质量最好（重音、语体、受限生成都更稳），但需要能访问 Anthropic 服务。'
  },
  custom: {
    label: '自定义 / 中转（OpenAI 兼容）',
    provider: 'openai', base: '', model: '', vision: '',
    note: '填你自己的中转地址。注意：中转方能看到你的请求内容，涉密材料慎选。'
  }
};

function applyPreset(key, fill) {
  const p = API_PRESETS[key] || API_PRESETS.custom;
  const noteEl = $('#presetNote');
  if (noteEl) noteEl.innerHTML = p.note;

  const isFree = key === 'free';
  // 共享代理模式下地址、模型、Key 都由服务端决定，摆在这只会让人困惑；
  // 免费公共 AI 不需要 Key 和 Endpoint，只留一个模型下拉
  const hideKeyBase = !!p.shared || isFree;
  ['#apiKeyRow', '#apiBaseRow'].forEach(s => {
    const el = $(s);
    if (el) el.classList.toggle('hide', hideKeyBase);
  });
  ['#apiModelRow'].forEach(s => {
    const el = $(s);
    if (el) el.classList.toggle('hide', !!p.shared || isFree);   // 免费 AI 用下拉，不用手填
  });
  const selRow = $('#apiModelSelRow');
  if (selRow) {
    selRow.classList.toggle('hide', !isFree);
    const sel = $('#apiModelSel');
    if (sel && isFree) {
      const cur = (S.api.preset === 'free' && S.api.model) || p.model;
      sel.innerHTML = (p.models || []).map(([v, t]) =>
        `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`).join('');
      if (fill) sel.value = p.model;
    }
  }
  if (!fill) return;
  if ($('#apiBase')) $('#apiBase').value = p.base;
  if ($('#apiModel')) $('#apiModel').value = p.model;
  if ($('#ocrModel') && p.vision) $('#ocrModel').value = p.vision;
}

/* ---------------- 导航 ---------------- */
function switchTab(t) {
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  $$('section[id^=p-]').forEach(s => s.classList.add('hide'));
  $('#p-' + t).classList.remove('hide');
  if (t === 'map') renderMap();
  if (t === 'train') nextQuestion();
  if (t === 'plan') renderPlan();
  if (t === 'report') renderReport();
  if (t === 'sla') renderSLA();
  if (t === 'guide' && window.Guide) window.Guide.render();
  window.scrollTo(0, 0);
}
$$('#tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.t));

/* ---------------- 导入 ---------------- */
{
  const sel = $('#apiPreset');
  if (sel) {
    const keys = Object.keys(API_PRESETS).filter(k => k !== 'proxy' || hasProxy());
    sel.innerHTML = keys.map(k => `<option value="${k}">${API_PRESETS[k].label}</option>`).join('');
    // 老存档没有 preset：有 Key 的按 base 反推，一个都没有就直接给免费的（开箱即用）
    let guess = S.api.preset || '';
    if (!guess) {
      if (hasProxy() && !S.api.key) guess = 'proxy';
      else if (S.api.key) guess = 'custom';
      else guess = 'free';
    }
    if (!S.api.preset && S.api.base && S.api.key) {
      guess = keys.find(k => API_PRESETS[k].base && S.api.base.indexOf(API_PRESETS[k].base.replace(/^https?:\/\//, '')) >= 0)
        || guess;
    }
    if (keys.indexOf(guess) < 0) guess = 'custom';
    sel.value = guess;
    sel.onchange = () => applyPreset(sel.value, true);
    const msel = $('#apiModelSel');
    if (msel) msel.onchange = () => { S.api.model = msel.value; };
    applyPreset(guess, false);
  }
  if (S.api) { $('#apiBase').value = S.api.base || ''; $('#apiKey').value = S.api.key || ''; $('#apiModel').value = S.api.model || ''; }
  const az = $('#autoZh');
  if (az) {
    az.checked = S.autoZh !== false;
    az.onchange = () => { S.autoZh = az.checked; save(); };
  }
}
$('#exam').value = S.exam || 'B1';
$('#examDate').value = S.examDate || '';
if (S.rawText) { $('#src').value = S.rawText; updateSrcStat(); }

function updateSrcStat() {
  const t = $('#src').value;
  const words = (t.match(/[A-Za-zÀ-ÿ]+/g) || []).length;
  $('#srcStat').textContent = `${words} 词 · ${sentences(t).length} 句`;
}
$('#src').oninput = updateSrcStat;

/* ========== 文件导入：PDF / txt / md / csv ==========
   体积策略：
     · 100 MB 硬拒 —— 再大浏览器主线程会直接卡死
     · 25 MB / 200 页起软提示 —— 让用户知道要等
     · 正文最终截到 MAX_TEXT 字符 —— 超过这个量对背单词没意义 */
const MAX_BYTES = 100 * 1024 * 1024;
const WARN_BYTES = 25 * 1024 * 1024;
const WARN_PAGES = 200;
const MAX_TEXT = 400000;

const fmtSize = b => (b < 1024 * 1024 ? (b / 1024).toFixed(0) + ' KB' : (b / 1024 / 1024).toFixed(1) + ' MB');

// big PDF 的正文会撑爆 localStorage（约 5 MB），集合时被自动裁掉，这里给用户一个交代
window.notifyStorageTrim = function () {
  setProg('浏览器本地存储放不下这份材料了，已经<b>丢掉原文正文</b>以保住你的单词卡和复习进度（不影响当前会话里继续用）。', true);
};

function setProg(html, show) {
  const el = $('#pdfProg');
  if (!el) return;
  el.innerHTML = html;
  el.classList.toggle('hide', !show);
}

$('#fileInput').onchange = e => {
  const f = e.target.files[0];
  e.target.value = '';               // 允许连续选同一个文件
  if (f) handleFile(f);
};

// 拖拽：整页随便放，滚动区也能接住
['dragover', 'drop'].forEach(ev => {
  window.addEventListener(ev, e => { e.preventDefault(); }, false);
});
window.addEventListener('drop', e => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f);
}, false);

async function handleFile(f) {
  if (f.size > MAX_BYTES) {
    alert(`这个文件有 ${fmtSize(f.size)}，超过 100 MB 上限。\n建议先拆成几份（比如按章节导出），只留跟考试相关的部分。`);
    return;
  }
  const isPdf = /\.pdf$/i.test(f.name) || /pdf/i.test(f.type || '');
  if (isPdf) return await handlePdf(f);

  // 图片：直接当一页丢去 OCR（讲义拍照、扫描 App 导出的单页都是这种）
  const isImg = /^image\//.test(f.type || '') || /\.(png|jpe?g|webp|bmp|tiff?|heic)$/i.test(f.name || '');
  if (isImg) return await handleImage(f);

  // Office / EPUB / RTF：docx、pptx 本质是 zip 包，当纯文本读会直接一屏乱码，必须走解析
  const nm = f.name || '';
  if (/\.(docx|pptx|xlsx|odt|epub|rtf|doc|ppt)$/i.test(nm)) return await handleOffice(f);
  try {
    // 扩展名不对（或干脆没有扩展名）时看文件头：PK = zip 系，D0CF11E0 = 老版 Office
    const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
    if ((head[0] === 0x50 && head[1] === 0x4b) || (head[0] === 0xd0 && head[1] === 0xcf)) return await handleOffice(f);
  } catch (e) { /* 取不到文件头就按纯文本处理 */ }

  if (f.size > WARN_BYTES && !confirm(`纯文本文件有 ${fmtSize(f.size)}，解析会比较慢。继续？`)) return;
  const r = new FileReader();
  r.onload = () => {
    $('#src').value = String(r.result).slice(0, MAX_TEXT);
    updateSrcStat();
    setProg(`已载入 <b>${f.name}</b>（${fmtSize(f.size)}）`, true);
  };
  r.readAsText(f, 'utf-8');
}

async function handlePdf(f) {
  const big = f.size > WARN_BYTES;
  if (big && !confirm(`这份 PDF 有 ${fmtSize(f.size)}，页数多的话可能要等十几秒，期间页面会卡住。\n继续吗？`)) return;

  setProg(`正在解析 <b>${f.name}</b>（${fmtSize(f.size)}）…`, true);
  await new Promise(r => setTimeout(r, 30));   // 让这行提示先画出来

  const t0 = Date.now();
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const res = await window.PDFText.extractPdfText(bytes, (pct, label) => {
      setProg(`正在解析 <b>${f.name}</b> — ${label}<br><span style="opacity:.6">${pct}%</span>`, true);
    });
    const ms = Date.now() - t0;

    // 有文本层就用文本层 —— 比 OCR 准得多，也快得多
    if (!res.scanned && res.text.trim().length > 80) {
      $('#src').value = res.text.slice(0, MAX_TEXT);
      updateSrcStat();
      let note = `已从 PDF 提取 <b>${res.pageCount}</b> 页 / <b>${res.text.length}</b> 字符，用时 ${ms} ms。`;
      if (res.text.length > MAX_TEXT) note += ` 超长部分已截断（保留前 ${MAX_TEXT} 字符），足够抽考点了。`;
      if (res.pageCount > WARN_PAGES) note += ` 页数偏多，建议按章节拆分成几个文件分别解析，速度会快很多。`;
      setProg(note, true);
      clearOcrPanel();
      return;
    }

    // 文本很薄：试着把页面图片抠出来，能抠到就给 OCR 面板
    setProg(`这份 PDF 几乎没有文本层（扫描件？），正在取页面图片…`, true);
    await new Promise(r => setTimeout(r, 30));
    let imgs = { pages: [], unsupported: [], pageCount: res.pageCount || 0 };
    try { imgs = await window.OCR.extractPageImages(bytes, (p, l) => setProg(`取页面图片 — ${l}`, true)); }
    catch (e) { /* 抠不出来就走原来的提示 */ }

    if (imgs.pages.length) { showOcrPanel(f.name, imgs); return; }

    setProg(`<b>没能读出文字</b>（${res.pageCount} 页，文本层 ${res.text.length} 字符，也取不到页面图片）。
      <br>常见原因：加密的 PDF、纯矢量图、或者用了 JPXDecode（JPEG 2000）这种浏览器解不了的压缩。
      <br>试试用系统「预览」打开后重新导出一份，或者直接在原文里复制粘贴到下面的框里。`, true);
  } catch (err) {
    setProg(`<b>解析失败：</b>${err && err.message ? err.message : err}
      <br>常见原因：文件加密、PDF 损坏、或者用了不支持的压缩算法。先把 PDF 用系统预览另存一份再试。`, true);
  }
}

async function handleImage(f) {
  setProg(`这是一张图片（${fmtSize(f.size)}），准备识别…`, true);
  $('#ocrPanel').innerHTML = '';
  await runOcr([{ blob: f, page: 1 }], f.name);
}

const OFFICE_LABEL = {
  docx: 'Word 文档（.docx）', pptx: 'PowerPoint（.pptx）', xlsx: 'Excel 表格（.xlsx）',
  odt: 'OpenDocument（.odt）', epub: 'EPUB 电子书', rtf: 'RTF 文档',
  doc: 'Word 97 文档（.doc）', ppt: 'PowerPoint 97（.ppt）'
};

async function handleOffice(f) {
  setProg(`正在解析 <b>${f.name}</b>（${fmtSize(f.size)}）…`, true);
  await new Promise(r => setTimeout(r, 30));   // 让提示先画出来
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const res = await window.Office.readFile(bytes, f.name || '', (pct, label) => {
      setProg(`正在解析 <b>${f.name}</b> — ${label}`, true);
    });
    const text = (res.text || '').trim();

    if (text.length < 20) {
      setProg(`<b>${f.name}</b> 里没抽出可读正文${res.note ? '（' + res.note + '）' : ''}。
        <br>常见情况：整份文件其实都是图片（扫描页、截图贴进 Word）。
        <br>这种请把相关页面导出成图片或 PDF，再用 OCR 识别。`, true);
      return;
    }

    $('#src').value = text.slice(0, MAX_TEXT);
    updateSrcStat();
    let note = `已从 <b>${OFFICE_LABEL[res.kind] || res.kind}</b> 提取 <b>${text.length}</b> 字符`;
    if (res.note) note += '，' + res.note;
    if (text.length > MAX_TEXT) note += `。超长部分已截断（保留前 ${MAX_TEXT} 字符）`;
    if (res.kind === 'doc' || res.kind === 'ppt') note += '。想要更准，请另存为 .docx / .pptx 再传一次';
    setProg(note + '。', true);
    clearOcrPanel();
  } catch (err) {
    setProg(`<b>解析失败：</b>${err && err.message ? err.message : err}
      <br>如果是加了密的文档，请先去掉密码；旧格式（.doc/.ppt）建议另存为 .docx / .pptx。`, true);
  }
}

/* ========== OCR ========== */
let pendingScan = null;        // 当前待识别的页面图片

function clearOcrPanel() { const p = $('#ocrPanel'); if (p) p.innerHTML = ''; }

function ocrEngineOptions(sel) {
  return [['auto', '自动（有 Key 用视觉模型，否则 Tesseract）'], ['vision', '视觉模型（需要 API Key）'], ['tesseract', 'Tesseract.js（本地，需下载模型）']]
    .map(([v, t]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${t}</option>`).join('');
}

function resolveEngine(sel) {
  const e = sel || S.ocr.engine || 'auto';
  return e === 'auto' ? (hasLLM() ? 'vision' : 'tesseract') : e;
}

function showOcrPanel(name, imgs) {
  pendingScan = imgs.pages;
  const reasons = [...new Set((imgs.unsupported || []).map(u => u.reason))];
  const max = parseInt(S.ocr.maxPages, 10) || 20;
  $('#ocrPanel').innerHTML = `
    <div class="ocrbox">
      <h3>这是扫描件：没有文本层，要走 OCR</h3>
      <div class="mut">共 ${imgs.pageCount || imgs.pages.length} 页，取出 <b>${imgs.pages.length}</b> 张可用的页面图片。
        ${reasons.length ? `<br>另有 ${imgs.unsupported.length} 页用了浏览器解不了的压缩（${reasons.join('、')}），这些页会跳过。` : ''}
        ${imgs.pages.length > max ? `<br>默认只识别前 ${max} 页，可以在「设置」里改。` : ''}
      </div>
      <div class="row">
        <select id="ocrEngineSel">${ocrEngineOptions(S.ocr.engine)}</select>
        <input type="text" id="ocrRange" placeholder="页码范围，如 1-10（留空＝全部）">
        <button class="btn pri" id="btnRunOcr">开始识别</button>
      </div>
      <div id="ocrStat" class="mut" style="margin-top:8px"></div>
    </div>`;
  setProg(`扫描件已就绪，选好引擎点「开始识别」。`, true);
  $('#btnRunOcr').onclick = () => runOcr(pendingScan, name, true);
}

// 解析 "1-10" / "1,3,5" / "3" 这样的页码范围
function parseRange(str, total) {
  const s = (str || '').trim();
  if (!s) return null;
  const set = new Set();
  s.split(/[,，\s]+/).forEach(part => {
    const m = part.match(/^(\d+)(?:[-~](\d+))?$/);
    if (!m) return;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= total) set.add(i);
  });
  return set.size ? [...set].sort((x, y) => x - y) : null;
}

async function runOcr(pages, name, useRange) {
  if (!pages || !pages.length) { alert('没有可识别的页面。'); return; }
  const sel = $('#ocrEngineSel') ? $('#ocrEngineSel').value : S.ocr.engine;
  const engine = resolveEngine(sel);
  if (engine === 'vision' && !hasLLM()) {
    alert('用视觉模型识别需要先在「设置」里填 API Key。\n或者把引擎换成 Tesseract.js（本地跑，但首次要下载约 15 MB 模型）。');
    switchTab('setup');
    return;
  }

  let list = pages;
  if (useRange) {
    const want = parseRange($('#ocrRange') ? $('#ocrRange').value : '', pages.length);
    if (want) list = want.map(n => pages[n - 1]).filter(Boolean);
  }
  const max = parseInt(S.ocr.maxPages, 10) || 20;
  const capped = list.length > max;
  if (capped) list = list.slice(0, max);

  const btn = $('#btnRunOcr');
  if (btn) btn.disabled = true;
  const stat = $('#ocrStat');
  const t0 = Date.now();

  try {
    const res = await window.OCR.recognizeImages(list, {
      engine,
      api: Object.assign({}, S.api, { shared: !S.api.key && S.api.preset === 'proxy' }),
      model: S.ocr.model || S.api.model || '',
      langPath: S.ocr.langPath || '',
      maxPages: max,
      onProgress: (pct, label) => {
        const msg = `${name} — ${label}`;
        if (stat) stat.innerHTML = msg;
        setProg(`正在识别 <b>${name}</b> — ${label}`, true);
      }
    });

    const good = res.pages.filter(p => p.text && p.text.trim());
    const text = good.map(p => p.text).join('\n\n');
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    if (!text.trim()) {
      setProg(`识别完成，但没拿到文字（${res.pages.length} 页都空）。
        <br>换一个引擎试试 —— 视觉模型对倾斜、低对比度的扫描件耐受度明显更高。`, true);
    } else {
      $('#src').value = text.slice(0, MAX_TEXT);
      updateSrcStat();
      const words = (text.match(/[A-Za-zÀ-ÿ]+/g) || []).length;
      setProg(`识别完成：<b>${good.length}/${res.pages.length}</b> 页有文字，共 <b>${words}</b> 词，用时 ${secs}s。
        ${capped ? `<br>只识别了前 ${max} 页，更多请到「设置」调上限或分批处理。` : ''}
        <br>OCR 难免有错，<b>扫一眼下面的文本再点解析</b>。`, true);
    }

    // 每页质量一览：哪几页没识别出来，一眼能看到
    if (stat) {
      stat.innerHTML = '<div class="ocrpage">' + res.pages.map(p => {
        const cls = p.error ? 'error' : (p.quality || (p.text ? 'ok' : 'empty'));
        const tip = p.error ? p.error : (p.text ? `${(p.text.match(/\S+/g) || []).length} 词` : '空页');
        return `<span class="${cls}" title="${String(tip).replace(/"/g, '')}">${p.page}</span>`;
      }).join('') + '</div><div class="hint">绿色＝识别正常，黄色＝可能识别歪了，红色＝失败或空页。</div>';
    }
    if (btn) btn.disabled = false;
  } catch (err) {
    setProg(`<b>识别失败：</b>${err && err.message ? err.message : err}
      <br>如果是引擎下载失败，检查网络，或到「设置」里换个语言包地址。`, true);
    if (btn) btn.disabled = false;
  }
}

const SAMPLE = `Je m'appelle Léa, j'ai vingt-deux ans et je vis à Lyon depuis trois ans. J'étudie l'architecture à l'université, et le week-end je travaille dans un petit café près de la gare.

Quand j'avais dix ans, j'habitais dans un village à côté de la montagne. Ma grand-mère habitait avec nous et je suis allée chez elle tous les dimanches jusqu'à ses quatre-vingts ans. Elle cuisinait très bien et elle m'a appris à faire le pain. Je crois que c'est là que j'ai découvert le goût des choses simples.

Aujourd'hui, la vie urbaine est plus rapide, mais elle reste stimulant. Il faut que je travaille beaucoup si je veux terminer mon diplôme l'année prochaine. Bien que le loyer soit trop élevé, nous avons décidé de louer un nouvel appartement dans le quartier parce que le propriétaire a accepté de faire des travaux. Je pense déménager au mois de mars.`;

$('#loadSample').onclick = () => { $('#src').value = SAMPLE; updateSrcStat(); };

$('#btnAnalyze').onclick = async () => {
  const text = $('#src').value.trim();
  if (text.length < 80) { alert('材料太短了，至少粘贴一段完整的法语课文或讲义。'); return; }
  $('#btnAnalyze').disabled = true; $('#btnAnalyze').textContent = '解析中…';
  await new Promise(r => setTimeout(r, 60));
  const v = extractVocab(text);
  const g = extractGrammar(text);
  S.exam = $('#exam').value;
  S.examDate = $('#examDate').value;
  S.rawText = text;
  S.vocab = v;
  S.grammar = g;
  save();
  $('#btnAnalyze').disabled = false; $('#btnAnalyze').textContent = '解析并生成考点图谱';

  const hits = v.filter(x => x.inDict).length;
  const missing = v.filter(x => !x.zh).length;
  const zhLine = missing === 0
    ? '<br>所有词目都已有中文释义。'
    : (hasLLM()
      ? `<br>有 <b>${missing}</b> 个词还没有中文释义（离线词库只收录约 400 条核心词，专业词汇要靠模型补）。
         <button class="btn fillZhBtn" style="margin-left:8px">补齐中文释义</button>`
      : '<br>提示：释义为空是因为离线词库只有约 400 条核心词。到「设置」选一项（免费公共 AI 也行）即可自动补齐中文释义与等级校准。');

  const noteHtml = `<div class="note" style="margin-top:12px">
    解析完成：<b>${v.length}</b> 个候选词目，其中 <b>${hits}</b> 个命中内置词库（含中文释义与 CEFR 等级）；识别到 <b>${g.length}</b> 类语法结构。<br>
    下一步：在这张表里勾选要背的词，或者直接点「加入最高频 50 个」。${zhLine}
  </div>`;
  $('#importNote').innerHTML = noteHtml;
  $('#mapNote').innerHTML = noteHtml;
  renderMap();
  switchTab('map');

  // 开了开关就顺手把这批补上，省得用户再点一次。
  // 免费服务每批要 15–35 秒，自动阶段只补最高频的 24 个控制首屏等待，剩下的点按钮继续。
  if (S.autoZh !== false && missing > 0 && hasLLM()) await runFillZh(24);
};

/* ---------------- 自动补齐中文释义 ----------------
   离线词库只有几百条核心词，专业材料（工程制图、医学、法律…）几乎必然大量缺释义。
   这里按批把缺的词丢给模型，一次 8 个、带上原文里的上下文，
   既省请求次数，也让模型能选对义项（dessin 到底是"制图"还是"素描"，看句子就知道）。 */
/* 批量大小是实测调出来的：免费服务走 GET，prompt 要塞进 URL。
   一个汉字 UTF-8 编码后会变成 %XX%XX%XX 共 9 个字符，中文指令会让 URL 瞬间翻三倍，
   直接把对方拖超时 —— 所以下面这段指令特意写成英文，只有输出要求是中文。 */
const ZH_BATCH = 6;
const ZH_CTX = 42;

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function findContext(lemma, text) {
  if (!text) return '';
  const i = text.search(new RegExp('\\b' + escapeRe(lemma), 'i'));
  if (i < 0) return '';
  return text.slice(Math.max(0, i - 30), Math.min(text.length, i + lemma.length + 45))
    .replace(/\s+/g, ' ').trim();
}

function materialDomain() {
  const first = (S.rawText || '').split('\n').map(s => s.trim()).find(s => s.length > 8);
  return first ? first.slice(0, 70) : '';
}

function buildZhPrompt(batch) {
  const dom = materialDomain();
  const lines = batch.map((b, i) => `${i + 1}. ${b.lemma}${b.ctx ? ' [ex: ' + b.ctx + ']' : ''}`).join('\n');
  // 指令用英文写（见上面 ZH_BATCH 的注释），只有结果要求中文
  return `You are a French-Chinese dictionary. For each French word below output ONLY its Simplified Chinese meaning, one per line, same order. No numbers, no pinyin, no explanation, no examples.
${dom ? 'Domain of the source text: ' + dom + '. Pick the sense that fits this domain.\n' : ''}
${lines}`;
}

function parseZhReply(raw, n) {
  const out = [];
  String(raw || '').split('\n').forEach(l => {
    let t = l.trim()
      .replace(/^\s*(?:\d+\s*[.、)]|[-•*])\s*/, '')   // 去掉 "1. " "1、" "- " 之类
      .replace(/^\s*[*"'`]+|[*"'`]+\s*$/g, '')        // 去掉模型爱加的引号星号
      .trim();
    if (/[：:]/.test(t) && !/[一-龥]/.test(t.split(/[：:]/)[0])) t = t.replace(/^[^：:]*[：:]\s*/, '');
    if (/[<>{}]/.test(t)) return;                  // 混进来的标签碎片，别当释义
    if (t) out.push(t.slice(0, 24));
  });
  return out.slice(0, n);
}

// 返回「失败了几批」。公共服务的失败是间歇性的，某一批挂了不该让整轮白干，
// 所以这里只跳过失败的批次，成功的部分照常入库。
async function fillZh(words, onProg) {
  let failed = 0;
  for (let i = 0; i < words.length; i += ZH_BATCH) {
    const batch = words.slice(i, i + ZH_BATCH)
      .map(w => ({ lemma: w.lemma, ctx: findContext(w.lemma, S.rawText).slice(0, ZH_CTX) }));
    const done = Math.min(i + ZH_BATCH, words.length);
    if (onProg) onProg(0, `正在查第 ${i + 1}–${done} / ${words.length} 个词…`);
    try {
      let raw = '';
      try {
        raw = await callLLM(buildZhPrompt(batch), 400);
      } catch (e1) {
        if (onProg) onProg(0, `第 ${i + 1}–${done} 个词超时，重试中…`);
        await new Promise(r => setTimeout(r, 1500));
        raw = await callLLM(buildZhPrompt(batch), 400);   // 再失败就计入 failed
      }
      const res = parseZhReply(raw, batch.length);
      if (!res.length) throw new Error('没能解析出释义');
      batch.forEach((b, k) => { if (res[k]) S.gloss[b.lemma] = res[k]; });
    } catch (e) {
      failed++;
      if (onProg) onProg(0, `第 ${i + 1}–${done} 个词没查到，先跳过`);
    }
    save();
  }
  return failed;
}

function applyGloss() {
  let n = 0;
  S.vocab.forEach(v => { if (!v.zh && S.gloss[v.lemma]) { v.zh = S.gloss[v.lemma]; n++; } });
  return n;
}

async function runFillZh(limit) {
  const words = S.vocab.filter(v => !v.zh).sort((a, b) => b.count - a.count).slice(0, limit || 40);
  if (!words.length) return 0;
  let btns = $$('.fillZhBtn');
  if (!btns.length) {   // 从表格页手动触发时，提示区可能没有按钮，临时插一个承载进度
    const holder = document.createElement('div');
    holder.className = 'note';
    holder.innerHTML = '<button class="btn fillZhBtn">补齐中文释义</button>';
    const box = $('#mapNote');
    if (box && box.parentNode) box.parentNode.insertBefore(holder, box.nextSibling);
    btns = $$('.fillZhBtn');
  }
  const setLabel = t => btns.forEach(b => { b.textContent = t; });
  btns.forEach(b => { b.disabled = true; });
  setLabel('正在查第 1 个词…');
  const failed = await fillZh(words, (pct, label) => setLabel(label));
  const n = applyGloss();
  save(); renderMap();
  if (n > 0) {
    setLabel(failed
      ? `已补齐 ${n} 个词，另有 ${failed} 批没连上，点这里重试`
      : `已补齐 ${n} 个词`);
    if (failed) btns.forEach(b => { b.disabled = false; });
  } else {
    setLabel('一个都没查到，点这里重试');
    btns.forEach(b => { b.disabled = false; });
    alert('免费服务这会儿没响应。可以：\n1) 再点一次（公共服务是间歇性的，重试通常就好）\n'
      + '2) 到「设置」换个免费模型\n3) 或者填你自己的 Key，最稳');
  }
  return n;
}

// 提示区可能被重复渲染，用事件委托绑一次就够了
document.addEventListener('click', e => {
  const t = e.target;
  if (t && t.classList && t.classList.contains('fillZhBtn')) runFillZh(120);
});

function renderMap() {
  if (!S.vocab.length) switchTab('import');
  const lv = ['A1', 'A2', 'B1', 'B2'];
  const dist = lv.map(l => S.vocab.filter(v => v.level === l).length);
  $('#mapStats').innerHTML =
    `<div class="stat"><div class="n">${S.vocab.length}</div><div class="l">候选词目</div></div>` +
    `<div class="stat"><div class="n">${S.vocab.reduce((a, b) => a + b.count, 0)}</div><div class="l">总出现次数</div></div>` +
    `<div class="stat"><div class="n">${S.grammar.length}</div><div class="l">语法结构类</div></div>` +
    `<div class="stat"><div class="n">${S.cards.length}</div><div class="l">已加入复习</div></div>`;

  $('#grammarGrid').innerHTML = S.grammar.map(g => `
    <div class="acc">
      <div class="row"><span class="pill ${g.level === 'A1' ? 'a2' : ''}">${g.level}</span>
        <b style="font-size:13px">${g.name}</b><span class="mut" style="margin-left:auto">×${g.count}</span></div>
      <div class="mut" style="margin-top:5px">${g.samples.map(s => `<span class="chip">${esc(s)}</span>`).join(' ')}</div>
    </div>`).join('') || '<div class="empty">没有识别到明显的语法结构，换一段更长的材料试试。</div>';

  renderVocabTable();
}

function renderVocabTable() {
  const lf = $('#fLevel').value, pf = $('#fPos').value, kw = $('#fKw').value.trim().toLowerCase();
  const rows = S.vocab.filter(v =>
    (!lf || v.level === lf) && (!pf || v.pos === pf) &&
    (!kw || v.lemma.includes(kw) || (v.zh || '').includes(kw))
  );
  const posName = { n: '名词', v: '动词', adj: '形容词', adv: '副词', p: '介词', conj: '连词', det: '限定词' };
  $('#vocabTable').innerHTML = `<thead><tr>
      <th style="width:34px"></th><th>词目</th><th>等级</th><th>词性</th><th>中义</th><th style="width:56px">词频</th><th style="width:70px">状态</th></tr></thead><tbody>
    ${rows.slice(0, 300).map(v => {
      const inDeck = S.cards.some(c => c.lemma === v.lemma);
      return `<tr>
        <td><input type="checkbox" class="sel" data-l="${esc(v.lemma)}" ${inDeck ? 'disabled' : ''}></td>
        <td class="fr">${esc(v.lemma)}${v.gender ? ` <span class="mut">(${v.gender})</span>` : ''}</td>
        <td>${v.level}${v.levelGuess ? ' <span class="pill">推测</span>' : ''}</td>
        <td>${posName[v.pos] || v.pos}</td>
        <td class="zh">${v.zh ? esc(v.zh) : '<span class="mut">待补</span>'}</td>
        <td class="mut">${v.count}</td>
        <td class="mut">${inDeck ? '已加入' : ''}</td></tr>`;
    }).join('')}</tbody>`;
  $('#vocabTable').dataset.count = rows.length;
}

['#fLevel', '#fPos'].forEach(id => $(id).onchange = renderVocabTable);
$('#fKw').oninput = renderVocabTable;

function addToDeck(lemmas) {
  let n = 0;
  lemmas.forEach(l => {
    if (S.cards.some(c => c.lemma === l)) return;
    const v = S.vocab.find(x => x.lemma === l);
    if (!v) return;
    S.cards.push(initCard(v.lemma, {
      pos: v.pos, level: v.level, zh: v.zh, gender: v.gender,
      count: v.count, sent: v.sent[0] || ''
    }));
    n++;
  });
  save();
  renderVocabTable();
  return n;
}
$('#btnAddTop50').onclick = () => {
  const l = S.vocab.slice(0, 50).map(v => v.lemma);
  alert(`已加入 ${addToDeck(l)} 个新词到复习计划。`);
};
$('#btnAddSelected').onclick = () => {
  const l = $$('input.sel:checked:not(:disabled)').map(i => i.dataset.l);
  if (!l.length) { alert('先在表格里勾选要背的词。'); return; }
  alert(`已加入 ${addToDeck(l)} 个新词到复习计划。`);
};

/* ---------------- 训练 ---------------- */
const MODES = {
  recognize: { name: '形 → 义', needs: 'any' },
  listen: { name: '听 → 形', needs: 'any' },
  use: { name: '完形填空', needs: 'sent' },
  conj: { name: '动词变位', needs: 'verb' },
  produce: { name: '主动输出', needs: 'any' },
  read: { name: '受限阅读', needs: 'any' }
};
$$('#modeSwitch button').forEach(b => b.onclick = () => {
  $$('#modeSwitch button').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); S.mode = b.dataset.m; save(); nextQuestion();
});
if (S.mode) $$('#modeSwitch button').forEach(x => x.classList.toggle('on', x.dataset.m === S.mode));

function pickCard() {
  if (!S.cards.length) return null;
  const due = dueCards(S.cards);
  const pool = due.length ? due : S.cards.filter(c => !c.suspended);
  let c = pool[Math.floor(Math.random() * pool.length)];
  if (S.mode === 'use') { const s = pool.filter(x => x.sent); if (s.length) c = s[Math.floor(Math.random() * s.length)]; else return { noSent: true }; }
  if (S.mode === 'conj') { const v = pool.filter(x => x.pos === 'v'); if (v.length) c = v[Math.floor(Math.random() * v.length)]; else return { noVerb: true }; }
  return c;
}
function distractors(card, field, n = 3) {
  const pool = S.vocab.filter(v => v.lemma !== card.lemma && v[field]);
  const out = [];
  while (out.length < n && pool.length) {
    const p = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    out.push(p[field]);
  }
  return out;
}

function nextQuestion() {
  const area = $('#quizArea');
  if (!S.cards.length) {
    area.innerHTML = `<div class="empty">还没有卡片。到「考点」页勾选单词并点击「加入最高频 50 个」。</div>`;
    $('#trainStat').textContent = '';
    return;
  }
  const c = pickCard();
  const due = dueCards(S.cards).length;
  $('#trainStat').textContent = `${S.cards.length} 张卡 · 今日到期 ${due} 张`;

  if (c && c.noSent) { area.innerHTML = `<div class="empty">这批材料里没有可用的例句上下文，先换「认 · 形义」模式。</div>`; return; }
  if (c && c.noVerb) { area.innerHTML = `<div class="empty">复习计划里还没有动词，先加入一些动词再来练变位。</div>`; return; }
  if (!c) { area.innerHTML = `<div class="empty">没有可用的卡片。</div>`; return; }

  Q = { card: c, mode: S.mode };
  const builders = { recognize: buildRecognize, listen: buildListen, use: buildUse, conj: buildConj, produce: buildProduce, read: buildRead };
  area.innerHTML = builders[S.mode](c);
  bindQuiz();
}

function speakBtn(sel, val) {
  const b = $(sel); if (b) b.onclick = () => { if (!speak(val)) alert('当前浏览器不支持法语语音合成，建议用 Chrome 或 Safari。'); };
}
function bindQuiz() {
  $$('.opt').forEach(o => o.onclick = () => answer(o.dataset.v === '1', o.dataset.a));
  const chk = $('#btnCheck'); if (chk) chk.onclick = () => answerFree();
  speakBtn('#btnSpeak', Q?.speakText || Q?.card?.lemma);
  $$('.grade').forEach(b => b.onclick = () => gradeDesktop(parseInt(b.dataset.q, 10)));
  if (Q.mode === 'read') $('#gradeRow').classList.remove('hide');   // 阅读模式直接收口
}

function gradeDesktop(q) {
  if (!Q) return;
  review(Q.card, q);
  S.stats.reviews++; if (q > 0) S.stats.correct++;
  save();
  toast(q > 0 ? '已记录，下次复习在 ' + Q.card.interval + ' 天后' : '已重置短期熟记，明天再见');
  nextQuestion();
}

function answer(isRight, userAnswer) {
  const box = $('#feedback');
  const note = Q.expect ? `参考答案：<span class="fr">${esc(Q.expect)}</span>` : '';
  box.className = 'fb ' + (isRight ? 'ok' : 'no');
  box.innerHTML = `${isRight ? '正确' : (Q.expect ? '不正确' : '已记录')} ${note}`;
  if (!isRight && userAnswer) document.querySelectorAll('.opt').forEach(o => { if (o.dataset.a === userAnswer) o.classList.add('no'); });
  document.querySelectorAll('.opt').forEach(o => { if (o.dataset.v === '1') o.classList.add('ok'); });
  $('#gradeRow').classList.remove('hide');
}
function answerFree() {
  const val = $('#freeInput').value;
  const g = Array.isArray(Q.expect)
    ? (Q.blanks.map((b, i) => gradeAnswer(($('#fi_' + i) || {}).value || '', b)).every(x => x.ok))
    : gradeAnswer(val, Q.expect);
  const detail = Array.isArray(Q.expect)
    ? Q.blanks.map((b, i) => { const x = gradeAnswer(($('#fi_' + i) || {}).value || '', b); return `${i + 1}. ${x.msg}${x.note ? ' — ' + x.note : ''}`; }).join('<br>')
    : (g.msg + (g.note ? ' — ' + g.note : ''));
  $('#feedback').className = 'fb ' + (g.ok ? 'ok' : 'no');
  $('#feedback').innerHTML = detail;
  $('#gradeRow').classList.remove('hide');
  Q.selfOk = g.ok;
}

function gradeRowHTML() {
  return `<div id="gradeRow" class="hide" style="margin-top:14px">
    <div class="mut" style="margin-bottom:6px">你自己判定一下掌握程度，系统会据此次排下一次复习：</div>
    <div class="row">
      <button class="btn grade" data-q="0">忘记了</button>
      <button class="btn grade" data-q="1">很费劲</button>
      <button class="btn grade" data-q="2">想起来了</button>
      <button class="btn pri grade" data-q="3">很简单</button>
    </div></div>`;
}

function buildRecognize(c) {
  let opts;
  if (c.zh) {
    opts = shuffle([{ v: 1, a: c.zh }, ...distractors(c, 'zh').map(z => ({ v: 0, a: z }))]);
  } else {
    // 离线词库没有中义时，退化成「词形 → 同义/近义候选」不现实，改为英法歧义题：给出词性与等级线索
    opts = shuffle([{ v: 1, a: c.lemma + '（这就是目标词）' }, ...distractors(c, 'lemma').map(z => ({ v: 0, a: z }))]);
  }
  Q.expect = null; Q.speakText = c.lemma;
  return `<div class="qbox">
    <div class="row"><span class="pill">${c.level}</span><span class="mut">${c.count || ''} 次 · 复习 ${c.reps} 次</span>
      <button class="btn ghost" id="btnSpeak" style="margin-left:auto">🔊 朗读</button></div>
    <div class="big fr" style="margin-top:10px">${esc(c.lemma)}</div>
    ${c.gender ? `<div class="hint">性：${c.gender === 'm' ? '阳性' : '阴性'} — 背的时候请连冠词一起背</div>` : ''}
    <div class="opts">${opts.map(o => `<button class="opt" data-v="${o.v}" data-a="${esc(o.a)}">${esc(o.a)}</button>`).join('')}</div>
    <div id="feedback" class="fb hide"></div>${gradeRowHTML()}
  </div>`;
}
function buildListen(c) {
  Q.expect = c.lemma; Q.speakText = c.lemma;
  const opts = shuffle([{ v: 1, a: c.lemma }, ...distractors(c, 'lemma').map(z => ({ v: 0, a: z }))]);
  setTimeout(() => speak(c.lemma), 250);
  return `<div class="qbox">
    <div class="row"><span class="pill">听力辨形</span><span class="mut">${c.level}</span>
      <button class="btn ghost" id="btnSpeak" style="margin-left:auto">🔊 再听一次</button></div>
    <div style="text-align:center;margin:22px 0"><button class="btn pri" onclick="speak(${JSON.stringify(c.lemma)})" style="font-size:15px;padding:14px 26px">播放法语发音</button></div>
    <div class="opts">${opts.map(o => `<button class="opt" data-v="${o.v}" data-a="${esc(o.a)}"><span class="fr">${esc(o.a)}</span></button>`).join('')}</div>
    <div id="feedback" class="fb hide"></div>${gradeRowHTML()}
  </div>`;
}
function buildUse(c) {
  let s = c.sent || (S.rawText.match(new RegExp('[^.!?]*\\b' + c.lemma + '\\b[^.!?]*[.!?]')) || [null])[0] || '';
  const re = new RegExp('\\b(' + c.lemma.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(\\w*)', 'i');
  const hidden = s.replace(re, '______');
  if (hidden === s) return `<div class="empty">例句里没找到这个词，切换到其它模式试试。</div>`;
  Q.expect = c.lemma; Q.blanks = [c.lemma]; Q.speakText = s;
  return `<div class="qbox">
    <div class="row"><span class="pill">完形</span><span class="mut">在材料的真实语境里恢复这个词</span>
      <button class="btn ghost" id="btnSpeak" style="margin-left:auto">🔊 朗读整句</button></div>
    <div class="sent" style="margin-top:14px">${esc(hidden)}</div>
    <div class="hint">提示：${esc(c.zh || '—')} · 长度 ${c.lemma.length}</div>
    <div class="row" style="margin-top:14px">
      <input type="text" id="fi_0" class="inline" placeholder="填词" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="btn pri" id="btnCheck">检查</button>
    </div>
    <div id="feedback" class="fb hide"></div>${gradeRowHTML()}
  </div>`;
}
function buildConj(c) {
  const t = TENSES[Math.floor(Math.random() * TENSES.length)];
  const i = Math.floor(Math.random() * 6);
  const forms = conjugate(c.lemma, t.id);
  Q.expect = forms[i]; Q.speakText = Q.expect;
  return `<div class="qbox">
    <div class="row"><span class="pill ${t.id === 'subj' ? 'w' : ''}">${t.name}</span>
      <span class="mut">${PRON[i]}</span>
      <button class="btn ghost" id="btnSpeak" style="margin-left:auto">🔊 朗读</button></div>
    <div style="margin-top:14px;font-size:15px"><span class="mut">原形</span> <span class="fr">${esc(c.lemma)}</span>
      &nbsp;→&nbsp; <span class="mut">${PRON[i]}</span> <span style="color:var(--brand-soft)">________</span></div>
    <div class="row" style="margin-top:14px"><input type="text" id="freeInput" class="inline" style="min-width:200px" placeholder="écrire ici" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn pri" id="btnCheck">检查</button></div>
    <div class="hint">${t.id === 'pc' ? '别忘了助动词 + 过去分词两部分。' : ''}${t.id === 'subj' ? '虚拟式由 nous 形式去 -ons 加尾缀构成（ils 除外）。' : ''}</div>
    <div id="feedback" class="fb hide"></div>${gradeRowHTML()}
  </div>`;
}
function buildProduce(c) {
  Q.expect = c.lemma; Q.speakText = c.lemma;
  const promptZh = c.zh || `用 ${c.lemma} 造句`;
  return `<div class="qbox">
    <div class="row"><span class="pill w">主动输出</span><span class="mut">写出来才算真的会</span>
      <button class="btn ghost" id="btnSpeak" style="margin-left:auto">🔊 朗读目标词</button></div>
    <div style="margin-top:12px;font-size:15px">用 <span class="fr">${esc(c.lemma)}</span> 写一个完整的法语句子</div>
    <div class="hint">中文提示：${esc(promptZh)}${c.gender ? ` · 注意这是${c.gender === 'm' ? '阳' : '阴'}性名词，冠词和形容词要配合` : ''}</div>
    <textarea id="freeInput" style="min-height:90px;margin-top:10px" placeholder="Écris ta phrase ici..."></textarea>
    <div class="row" style="margin-top:10px"><button class="btn pri" id="btnCheck">检查</button><button class="btn" id="btnLint">只看易错点</button></div>
    <div id="feedback" class="fb hide"></div>${gradeRowHTML()}
  </div>`;
}
function buildRead(c) {
  const p = genPassage(S.exam || 'B1', S.vocab.slice(0, 40), S.grammar, 3);
  Q.expect = null; Q.speakText = p.text;
  return `<div class="qbox">
    <div class="row"><span class="pill a2">受限输入 · ${esc(S.exam)}</span>
      <button class="btn ghost" id="btnSpeak" style="margin-left:auto">🔊 朗读全文</button></div>
    <div class="sent" style="margin-top:14px">${esc(p.text)}</div>
    <div class="note" style="margin-top:14px">${esc(p.note)}</div>
    <div class="hint">读法：先不查词读完一遍，看能抓住多少；再放音频跟着读一遍；遇到生词再去「考点」页查。</div>
    <div id="feedback" class="fb hide"></div>${gradeRowHTML()}
  </div>`;
}

$('#btnCheck') && null;
document.addEventListener('click', e => {
  if (e.target && e.target.id === 'btnLint') {
    const t = $('#freeInput').value.trim();
    if (!t) { $('#feedback').className = 'fb no'; $('#feedback').textContent = '先写点东西。'; return; }
    const issues = detectSLA(t);
    const used = normAns(t).includes(normAns(Q.expect));
    $('#feedback').className = 'fb ' + (used ? 'ok' : 'no');
    $('#feedback').innerHTML = `${used ? '目标词已正确使用 ✔' : '没有检测到目标词：' + esc(Q.expect)}` +
      (issues.length ? '<br><br>' + issues.map(i => `<b>${i.name}</b>：${i.samples.map(esc).join('；')}`).join('<br>') : '<br><br>没有发现常见易错点。');
  }
});

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let toastT;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);top:64px;background:#1F1E1C;color:#fff;padding:9px 16px;border-radius:20px;font-size:12.5px;z-index:99;opacity:0;transition:opacity .25s';
  requestAnimationFrame(() => el.style.opacity = .96);
  clearTimeout(toastT); toastT = setTimeout(() => el.style.opacity = 0, 2600);
}

/* ---------------- 排课 ---------------- */
function renderPlan() {
  const due = dueCards(S.cards);
  const learned = S.cards.filter(c => c.reps > 0).length;
  const days = S.examDate ? Math.max(0, daysUntil(S.examDate)) : 0;
  const perDay = days > 0 && S.cards.length ? Math.ceil(S.cards.length / days) : 0;
  $('#planStats').innerHTML =
    `<div class="stat"><div class="n">${due.length}</div><div class="l">今日到期</div></div>` +
    `<div class="stat"><div class="n">${learned}</div><div class="l">已见过</div></div>` +
    `<div class="stat"><div class="n">${days || '—'}</div><div class="l">${days ? '天后考试' : '未设考试日期'}</div></div>` +
    `<div class="stat"><div class="n">${perDay || '—'}</div><div class="l">${days ? '每天需新学' : '设日期后计算'}</div></div>`;

  $('#dueList').innerHTML = due.length ? due.slice(0, 60).map(c => `
    <div class="acc"><div class="row">
      <span class="fr" style="font-size:15px;min-width:120px">${esc(c.lemma)}</span>
      <span class="zh">${esc(c.zh || '')}</span>
      <span class="pill">${c.level}</span>
      <span class="mut" style="margin-left:auto">${c.reps ? `第 ${c.reps} 次 · 间隔 ${c.interval} 天` : '首次学习'}</span>
      <button class="btn ghost" onclick="speak(${JSON.stringify(c.lemma)})">🔊</button>
    </div></div>`).join('') : '<div class="empty">今天没有到期的卡片。要么去「考点」加词，要么休息。</div>';

  const hist = {};
  for (let i = 0; i < 14; i++) hist[addDays(i)] = 0;
  S.cards.forEach(c => { if (hist[c.due] !== undefined) hist[c.due]++; });
  const vals = Object.values(hist);
  const max = Math.max(1, ...vals);
  $('#forecast').innerHTML = Object.entries(hist).map(([d, n]) => {
    const h = Math.round(60 * n / max);
    return `<div style="text-align:center"><div style="height:60px;display:flex;align-items:flex-end;justify-content:center">
      <div style="width:26px;height:${h}px;background:var(--brand);border-radius:3px 3px 0 0"></div></div>
      <div class="mut" style="margin-top:4px">${n}</div><div class="mut" style="font-size:11px">${d.slice(5)}</div></div>`;
  }).join('');
}

$('#examDate').onchange = () => { S.examDate = $('#examDate').value; save(); };
$('#exam').onchange = () => { S.exam = $('#exam').value; save(); };

$('#btnExportAnki').onclick = () => {
  if (!S.cards.length) { alert('先加一些词。'); return; }
  const rows = S.cards.map(c => [
    `${c.lemma}${c.gender ? ' (' + c.gender + ')' : ''}`,
    c.zh || '', c.sent ? c.sent.replace(new RegExp(c.lemma, 'gi'), '[...]') : '', `allez_${c.level}_${c.pos}`
  ].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(','));
  const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'allez-anki.csv'; a.click();
};
$('#btnReset2').onclick = $('#btnReset').onclick = () => {
  if (!confirm('确认清空本机全部学习数据？此操作不可撤销。')) return;
  S = DEFAULT_STATE(); save(); location.reload();
};

/* ---------------- 验收 ---------------- */
function lvOrder(l) { return ({ A1: 1, A2: 2, B1: 3, B2: 4, C1: 5 })[l] || 3; }

function renderReport() {
  const total = S.cards.length;
  const known = S.cards.filter(c => c.reps > 0 && (c.history.at(-1)?.q || 0) > 0).length;
  const weak = S.cards.filter(c => c.lapses > 0);
  const acc = S.stats.reviews ? Math.round(100 * S.stats.correct / S.stats.reviews) : 0;
  $('#repStats').innerHTML =
    `<div class="stat"><div class="n">${total}</div><div class="l">在学词目</div></div>` +
    `<div class="stat"><div class="n">${known}</div><div class="l">已初步掌握</div></div>` +
    `<div class="stat"><div class="n">${acc}%</div><div class="l">自评正确率</div></div>` +
    `<div class="stat"><div class="n">${weak.length}</div><div class="l">反复忘词</div></div>`;

  radar(['词汇 A1-A2', '词汇 B1-B2', '动词变位', '语法结构', '主动输出', '易错点'], [
    masteryBy(l => lvOrder(l) <= 2 && l !== 'v'),
    masteryBy(l => lvOrder(l) >= 3),
    conjMastery(),
    grammarMastery(),
    Math.min(100, acc),
    slaScore()
  ]);

  const target = S.exam || 'B1';
  const tLv = lvOrder(target);
  const core = Object.keys(DICT).filter(w => DICT[w].level && lvOrder(DICT[w].level) <= tLv);
  const hit = core.filter(w => S.cards.some(c => c.lemma === w));
  const pct = core.length ? Math.round(100 * hit.length / core.length) : 0;
  $('#coverage').innerHTML = `
    <div class="row" style="margin-bottom:8px"><b style="font-size:20px">${pct}%</b><span class="mut">核心词汇覆盖（${hit.length} / ${core.length}）</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="hint" style="margin-top:10px">缺口最大的 ${target} 及以下常用词：</div>
    <div style="margin-top:6px">${core.filter(w => !S.cards.some(c => c.lemma === w)).slice(0, 40).map(w => `<span class="chip fr">${esc(w)}${DICT[w].gender ? ' (' + DICT[w].gender + ')' : ''} <span class="mut">${esc(DICT[w].zh || '')}</span></span>`).join('')}</div>`;

  $('#weakList').innerHTML = S.cards.filter(c => c.lapses > 0 || (c.history.at(-1)?.q === 0))
    .sort((a, b) => b.lapses - a.lapses).slice(0, 30)
    .map(c => `<span class="chip fr">${esc(c.lemma)} <span class="mut">忘 ${c.lapses} 次 · ${esc(c.zh || '')}</span></span>`).join('')
    || '<div class="empty">还没有明显的弱项。多做几轮再回来。</div>';
}
function masteryBy(fn) {
  const pool = S.cards.filter(c => { const d = DICT[c.lemma]; return fn(c.level || (d && d.level) || 'B1'); });
  if (!pool.length) return 0;
  const good = pool.filter(c => c.reps > 0 && (c.history.at(-1)?.q || 0) > 0).length;
  return Math.round(100 * good / pool.length);
}
function conjMastery() {
  const v = S.cards.filter(c => c.pos === 'v');
  if (!v.length) return 0;
  return Math.round(100 * v.filter(c => c.reps > 1).length / v.length);
}
function grammarMastery() {
  if (!S.grammar.length) return 0;
  return Math.min(100, Math.round(100 * Math.min(1, S.grammar.length / 8)));
}
function slaScore() {
  if (!S.rawText) return 0;
  const issues = detectSLA(S.rawText).reduce((a, b) => a + b.count, 0);
  return Math.max(0, 100 - issues * 6);
}

function radar(labels, values) {
  const n = labels.length, cx = 170, cy = 165, R = 115;
  const pt = (i, r) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const rings = [0.25, 0.5, 0.75, 1].map(k => `<polygon points="${labels.map((_, i) => pt(i, R * k).map(v => v.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="#E3E1DB" stroke-width="1"/>`).join('');
  const poly = values.map((v, i) => pt(i, R * Math.max(0.04, v / 100)).map(x => x.toFixed(1)).join(',')).join(' ');
  const lbl = labels.map((l, i) => {
    const [x, y] = pt(i, R + 24);
    const anchor = Math.abs(x - cx) < 8 ? 'middle' : (x > cx ? 'start' : 'end');
    return `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" text-anchor="${anchor}" font-size="12" fill="#5F5E5A">${esc(l)}</text>`;
  }).join('');
  const vals = values.map((v, i) => {
    const [x, y] = pt(i, R * Math.max(0.04, v / 100));
    return `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="3" fill="#1D4ED8"/>`;
  }).join('');
  $('#radar').innerHTML = `<svg width="360" height="330" viewBox="0 0 340 330" role="img" aria-label="能力雷达图">${rings}
    ${labels.map((_, i) => `<line x1="${cx}" y1="${cy}" x2="${pt(i, R)[0].toFixed(1)}" y2="${pt(i, R)[1].toFixed(1)}" stroke="#E3E1DB" stroke-width="1"/>`).join('')}
    <polygon points="${poly}" fill="#1D4ED8" fill-opacity="0.18" stroke="#1D4ED8" stroke-width="2"/>
    ${vals}${lbl}</svg>`;
}

/* ---------------- 易错点 ---------------- */
function renderSLA() {
  const found = S.rawText ? detectSLA(S.rawText) : [];
  $('#slaFound').innerHTML = found.length ? found.map(f => `
    <div class="acc"><div class="row"><b style="font-size:13px">${f.name}</b>
      <span class="pill ${f.level === 'A1' || f.level === 'A2' ? 'a2' : 'w'}">${f.level}</span>
      <span class="mut" style="margin-left:auto">疑似 ${f.count} 处</span></div>
      <div class="mut" style="margin-top:6px">${f.samples.map(s => `<span class="chip">${esc(s)}</span>`).join(' ')}</div>
      <div class="hint">${esc(f.tip || '')}</div></div>`).join('')
    : '<div class="empty">导入材料后这里会列出在你自己的文本里检测到的问题。</div>';

  $('#slaLib').innerHTML = SLA_LIB.map(s => `
    <div class="acc"><div class="row"><b style="font-size:13px">${s.name}</b>
      <span class="pill ${s.level === 'A1' || s.level === 'A2' ? 'a2' : 'w'}">${s.level}</span></div>
      <div class="grid g2" style="margin-top:6px">
        <div><div class="mut">常见错法</div><div class="fr" style="color:var(--bad)">${esc(s.wrong)}</div></div>
        <div><div class="mut">正确写法</div><div class="fr" style="color:var(--accent)">${esc(s.right)}</div></div>
      </div>
      <div class="hint"><b>为什么中国人会错：</b>${esc(s.why)}</div>
      <div class="hint"><b>破解办法：</b>${esc(s.tip)}</div></div>`).join('');
}

/* ---------------- 远程模型（可选） ---------------- */
/* 免费公共 AI：不需要 Key，但只提供 GET 形式的文本接口（POST 端点在不少网络里连不上）。
   代价是 prompt 要走 URL，所以调用方必须自己把请求压短 —— 见 fillZh 的分批策略。 */
async function callFreeAI(prompt, model) {
  const url = 'https://text.pollinations.ai/' + encodeURIComponent(prompt)
    + '?model=' + encodeURIComponent(model || 'openai-fast');
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 30000) : null;
  try {
    const r = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
    const t = (await r.text()).trim();
    if (!r.ok) throw new Error('HTTP ' + r.status);
    // 网络被拦、对方限流、或者代理插了一脚时，拿到的常常是 200 + 一个 HTML 页面。
    // 不挡住的话，<html> 会被当成中文释义写进词表。
    if (!t) throw new Error('对方返回了空内容');
    if (/^\s*<(!doctype|html|!--)/i.test(t) || /<html[\s>]/i.test(t) || /\bcloudflare\b/i.test(t.slice(0, 400))) {
      throw new Error('对方返回的是网页而不是结果（通常是限流或网络拦截）');
    }
    return t;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('免费服务超时了（多半是对方在排队）。换个模型再试，或者在「设置」里换成自己的 Key。');
    throw new Error('免费服务连不上：' + (e && e.message ? e.message : e) + '。换个模型再试，或者在「设置」里换成自己的 Key。');
  } finally { if (timer) clearTimeout(timer); }
}

async function callLLM(prompt, maxTokens = 1200) {
  const a = S.api;
  if (!hasLLM()) throw new Error('未配置 API Key');
  if (isFreeAI()) return await callFreeAI(prompt, a.model || 'openai-fast');
  const shared = !a.key && a.preset === 'proxy';   // 共享代理：由服务端带 Key，这里不能塞空的 authorization
  if (a.provider === 'claude') {
    const base = (a.base || 'https://api.anthropic.com').replace(/\/$/, '');
    const r = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-api-key': a.key,
        'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: a.model || 'claude-opus-4-6', max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  }
  const base = (a.base || 'https://api.openai.com/v1').replace(/\/$/, '');
  let auth = { 'content-type': 'application/json' };
  if (!shared) auth.authorization = 'Bearer ' + a.key;
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ model: a.model || 'gpt-4o', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}

// 从预设推出底层的 provider（实际发请求只用 'claude' / 'openai' 两种协议）
function currentProvider() {
  const k = $('#apiPreset') ? $('#apiPreset').value : 'custom';
  return (API_PRESETS[k] || API_PRESETS.custom).provider;
}
function readApiForm() {
  const preset = $('#apiPreset') ? $('#apiPreset').value : 'custom';
  // 免费公共 AI 的模型在下拉里选，其余服务商手填
  const model = (preset === 'free' && $('#apiModelSel'))
    ? $('#apiModelSel').value
    : ($('#apiModel') ? $('#apiModel').value.trim() : '');
  return {
    provider: currentProvider(), base: $('#apiBase').value.trim(),
    key: $('#apiKey').value.trim(), model
  };
}
$('#btnSaveApi').onclick = () => {
  S.api = readApiForm();
  S.api.preset = $('#apiPreset') ? $('#apiPreset').value : 'custom';
  // 预设顺手填的视觉模型一并存下来，免得用户还得再去 OCR 那栏点一次保存
  if ($('#ocrModel') && $('#ocrModel').value.trim()) S.ocr.model = $('#ocrModel').value.trim();
  const az = $('#autoZh');
  if (az) S.autoZh = az.checked;
  save(); toast('已保存到本机浏览器');
};
$('#btnTestApi').onclick = async () => {
  const btn = $('#btnTestApi'); btn.disabled = true; $('#apiStat').textContent = '连接中…';
  const backup = S.api;
  S.api = readApiForm();
  try {
    const t = await callLLM('Réponds uniquement: OK', 10);
    $('#apiStat').textContent = '连接成功：' + t.slice(0, 20);
  } catch (e) {
    $('#apiStat').textContent = '失败：' + e.message;
    S.api = backup;
  }
  btn.disabled = false;
};

/* ---------------- OCR 设置 ---------------- */
if (S.ocr) {
  if ($('#ocrEngine')) $('#ocrEngine').value = S.ocr.engine || 'auto';
  if ($('#ocrModel')) $('#ocrModel').value = S.ocr.model || '';
  if ($('#ocrLangPath')) $('#ocrLangPath').value = S.ocr.langPath || '';
  if ($('#ocrMaxPages')) $('#ocrMaxPages').value = String(S.ocr.maxPages || 20);
}
$('#btnSaveOcr').onclick = () => {
  S.ocr = {
    engine: $('#ocrEngine').value,
    model: $('#ocrModel').value.trim(),
    langPath: $('#ocrLangPath').value.trim(),
    maxPages: Math.max(1, Math.min(200, parseInt($('#ocrMaxPages').value, 10) || 20))
  };
  save();
  const s = $('#ocrSaveStat'); if (s) s.textContent = '已保存到本机浏览器';
  setTimeout(() => { if (s) s.textContent = ''; }, 2500);
};
$('#btnGuide2').onclick = () => { if (window.Guide) window.Guide.open(); };

/* ---------------- 备份 / 恢复 ----------------
   localStorage 会被清缓存、换浏览器、换设备带走，而且找不回来。
   导出一份 JSON 是唯一靠谱的兜底。 */
$('#btnExportAll').onclick = () => {
  try {
    const payload = {
      format: 'allez-backup', version: 1, exportedAt: new Date().toISOString(),
      // 明文导出给别人看没问题，但别指望它是隐私的：里面有你的 API Key。
      state: S
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'allez-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    const st = $('#backupStat');
    if (st) { st.textContent = `已导出 ${S.vocab.length} 词 / ${S.cards.length} 張卡片`; setTimeout(() => st.textContent = '', 4000); }
  } catch (e) {
    alert('导出失败：' + e.message);
  }
};
$('#btnImportAll').onclick = () => $('#backupInput').click();
$('#backupInput').onchange = async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';                       // 允许连续选同一个文件
  if (!f) return;
  const st = $('#backupStat');
  try {
    const payload = JSON.parse(await f.text());
    if (payload.format !== 'allez-backup' || !payload.state) throw new Error('不是 Allez 的备份文件');
    const incoming = payload.state;
    if (typeof incoming.vocab !== 'object' || !('cards' in incoming)) throw new Error('备份文件结构不对');

    const detail = `${incoming.vocab.length} 词 / ${incoming.cards.length} 張卡片` +
      (payload.exportedAt ? `（备份于 ${payload.exportedAt.slice(0, 10)}）` : '');
    const mine = S.vocab.length || S.cards.length;
    const merge = mine && confirm(
      `备份里有 ${detail}。\n\n` +
      `【确定】合并保留两边（词汇取并集，卡片按词条去重）\n` +
      `【取消】覆盖当前数据（现在有 ${S.vocab.length} 词 / ${S.cards.length} 張卡片）`
    );

    if (merge) {
      // 同一个词两边各有一份时，保留到期日更远的那份（= 复习进度更靠后的那份）
      const key = v => (v.lemma || '') + '|' + (v.surface || v.word || '');
      const mergeList = (mine, theirs) => {
        const map = new Map();
        [...theirs, ...mine].forEach(v => {
          const k = key(v);
          const cur = map.get(k);
          map.set(k, cur && String(cur.due || '') > String(v.due || '') ? cur : v);
        });
        return [...map.values()];
      };
      S.vocab = mergeList(S.vocab, incoming.vocab || []);
      S.cards = mergeList(S.cards, incoming.cards || []);
      S.stats.reviews = Math.max(S.stats.reviews, incoming.stats?.reviews || 0);
      S.stats.correct = Math.max(S.stats.correct, incoming.stats?.correct || 0);
      S.done = Object.assign({}, incoming.done || {}, S.done || {});
    } else {
      S = Object.assign(DEFAULT_STATE(), incoming);
    }
    S.ocr = Object.assign({ engine: 'auto', model: '', langPath: '', maxPages: 20 }, S.ocr || {});
    save();
    if (st) { st.textContent = merge ? `已合并 ${detail}` : `已恢复 ${detail}，刷新后生效`; }
    setTimeout(() => location.reload(), 900);
  } catch (err) {
    alert('恢复失败：' + (err.message || err));
  }
};

/* 启动 */
switchTab(S.rawText && S.cards.length ? 'train' : (S.rawText ? 'map' : 'import'));
