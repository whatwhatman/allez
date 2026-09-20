/* Allez! 法语备考引擎 — 引擎层
   纯前端、无依赖。没有 API Key 时用规则引擎跑，有 Key 时切换到远程模型。 */

/* ================= 词典装载 ================= */
const DICT = {};
DICT_RAW.trim().split('\n').forEach(line => {
  const p = line.split('|');
  if (p.length < 4) return;
  const w = p[0].trim().toLowerCase();
  if (!w) return;
  DICT[w] = { pos: p[1], level: p[2], gender: p[3], zh: (p[4] || '').trim() };
});

const VERBS = {};
VERB_RAW.trim().split('\n').forEach(line => {
  const p = line.split('|');
  if (p.length < 5) return;
  VERBS[p[0]] = {
    pres: p[1].split(','),
    subj: p[2].split(','),
    fut: p[3],
    pp: p[4].split(',')[0],
    aux: p[4].split(',')[1]
  };
  DICT[p[0]] = DICT[p[0]] || { pos: 'v', level: 'A1', gender: '', zh: '' };
  DICT[p[0]].pos = 'v';
});

const PRON = ['je', 'tu', 'il/elle', 'nous', 'vous', 'ils/elles'];
const PRON_SHORT = ['je', 'tu', 'il', 'nous', 'vous', 'ils'];
const TENSES = [
  { id: 'pres', name: '直陈式现在时' },
  { id: 'impar', name: '未完成过去时' },
  { id: 'pc', name: '复合过去时' },
  { id: 'futur', name: '简单将来时' },
  { id: 'cond', name: '条件式现在时' },
  { id: 'subj', name: '虚拟式现在时' }
];

/* ================= 文本工具 ================= */
const ELISION = /^(l|d|j|m|t|s|n|c|qu|jusqu|puisqu|quoiqu|lorsqu|presqu)'/i;

function stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function stripQuote(s) {
  return s.replace(/[’']/g, "'").replace(/^[^a-zA-ZÀ-ÿ]*'/, '');
}
function tokenize(text) {
  const out = [];
  // 连字符也算词内：week-end / petit-déjeuner 会被当作一个词
  const re = /[A-Za-zÀ-ÿŒœÆæ]+(?:[-'’][A-Za-zÀ-ÿŒœÆæ]+)*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    let w = raw.toLowerCase().replace(/[’]/g, "'");
    let prefix = '';
    if (w.indexOf("'") > 0) {
      const p = w.slice(0, w.indexOf("'") + 1);
      // 只有真正的省音才拆（l' d' j' qu'…），aujourd'hui 这类整体保留
      if (ELISION.test(p)) { prefix = p; w = w.slice(w.indexOf("'") + 1); }
    }
    out.push({ raw, w, start: m.index, prefix });
  }
  return out;
}
function sentences(text) {
  return text.replace(/\s+/g, ' ')
    .split(/(?<=[.!?;:…])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 12 && s.length < 400);
}

/* ================= 变位引擎 ================= */
/* 单数人称上 e → è 的动词（其余 -eler / -eter 动词走双写路线：appeler -> j'appelle） */
const EGRAVE_VERBS = new Set(['acheter', 'racheter', 'mener', 'amener', 'emmener', 'promener',
  'ramener', 'lever', 'enlever', 'élever', 'soulever', 'relever', 'peser', 'semer', 'crever',
  'acheter', 'geler', 'peler', 'démener']);

function stemOfRegular(inf) {
  if (/er$/.test(inf)) {
    const stem = inf.slice(0, -2);
    let nousStem = stem, vousStem = stem;
    if (/ger$/.test(inf)) { nousStem = stem + 'e'; }                   // mangeons（但 mangez）
    if (/cer$/.test(inf)) { nousStem = stem.slice(0, -1) + 'ç'; }      // commençons（但 commencez）
    // 词干交替：espér→espèr（é 变 è） / achèt（e 变 è） / appell（双写 l 或 t）
    let mutStem = null;
    if (/é/.test(stem.slice(-4))) {
      const i = stem.lastIndexOf('é');
      mutStem = stem.slice(0, i) + 'è' + stem.slice(i + 1);           // espérer -> espèr
    } else if (EGRAVE_VERBS.has(inf)) {
      const i = stem.lastIndexOf('e');
      if (i >= 0) mutStem = stem.slice(0, i) + 'è' + stem.slice(i + 1); // acheter -> achèt
    } else if (/(el|et)er$/.test(inf)) {
      mutStem = stem + stem.slice(-1);                                 // appeler -> appell
    }
    return { main: stem, plural: nousStem, vous: vousStem, mute: mutStem, type: 'er' };
  }
  if (/ir$/.test(inf)) {
    return { main: inf.slice(0, -2), plural: inf.slice(0, -2) + 'iss', vous: inf.slice(0, -2) + 'iss', type: 'ir' };
  }
  if (/re$/.test(inf)) {
    return { main: inf.slice(0, -2), plural: inf.slice(0, -2), vous: inf.slice(0, -2), type: 're' };
  }
  return { main: inf.slice(0, -2), plural: inf.slice(0, -2), vous: inf.slice(0, -2), type: 'other' };
}

function futStem(inf) {
  // perdre -> perdr- ，其余用完整不定式（parler -> parler-）
  return /re$/.test(inf) ? inf.slice(0, -1) : inf;
}

function ppOfRegular(inf) {
  if (/er$/.test(inf)) return inf.slice(0, -2) + 'é';      // parler -> parlé
  if (/uire$/.test(inf)) return inf.slice(0, -3) + 'uit';  // conduire -> conduit
  if (/ir$/.test(inf)) return inf.slice(0, -2) + 'i';      // finir -> fini
  if (/re$/.test(inf)) return inf.slice(0, -2) + 'u';      // perdre -> perdu
  return null;
}

function auxOf(inf) {
  if (/^se\s|^s’/.test(inf)) return 'être';
  return ETRE_VERBS.has(inf) ? 'être' : 'avoir';
}

function conjugate(inf, tense) {
  const V = VERBS[inf];
  if (V) {
    if (tense === 'pres') return V.pres.slice();
    if (tense === 'subj') return V.subj.slice();
    if (tense === 'futur') return ['ai','as','a','ons','ez','ont'].map(e => V.fut + e);
    if (tense === 'cond') return ['ais','ais','ait','ions','iez','aient'].map(e => V.fut + e);
    if (tense === 'impar') {
      let st = inf === 'être' ? 'ét' : V.pres[3].replace(/ons$/, '');
      return ['ais','ais','ait','ions','iez','aient'].map(e => st + e);
    }
    if (tense === 'pc') {
      const aux = V.aux;
      const auxForms = conjugate(aux, 'pres');
      return PRON.map((p, i) => auxForms[i] + ' ' + V.pp);
    }
  }
  const S = stemOfRegular(inf);
  let st = S.main, form;
  switch (tense) {
    case 'pres':
      if (S.type === 'er') {
        // -e / -es / -e, -ons / -ez, -ent（无声词尾用变音词干 espèr- / achèt-）
        const m = S.mute || S.main;
        return [m + 'e', m + 'es', m + 'e', S.plural + 'ons', S.vous + 'ez', m + 'ent'];
      }
      if (S.type === 'ir') {
        const m = S.main;
        return [m + 'is', m + 'is', m + 'it', S.plural + 'ons', S.plural + 'ez', S.plural + 'ent'];
      }
      if (S.type === 're') {
        const m = S.main;
        return [m + 's', m + 's', /d$/.test(m) ? m : m + 't', m + 'ons', m + 'ez', m + 'ent'];
      }
      break;
    case 'impar': {
      const nous = pluralNous(inf);
      st = nous.replace(/issons$/, 'iss').replace(/ons$/, '');
      if (/er$/.test(inf)) st = nous.replace(/geons$/, 'g').replace(/çons$/, 'ç').replace(/ons$/, '');
      return ['ais','ais','ait','ions','iez','aient'].map(e => st + e);
    }
    case 'futur':
      st = futStem(inf);
      return ['ai','as','a','ons','ez','ont'].map(e => st + e);
    case 'cond':
      st = futStem(inf);
      return ['ais','ais','ait','ions','iez','aient'].map(e => st + e);
    case 'subj': {
      st = pluralNous(inf).replace(/ons$/, '');
      return ['e','es','e','ions','iez','ent'].map(e => {
        // manger -> nous mangions（不是 mangeions）
        if (/ge$/.test(st) && /^i/.test(e)) return st.slice(0, -1) + e;
        return st + e;
      });
    }
    case 'pc': {
      const aux = auxOf(inf);
      const pp = ppOfRegular(inf) || VERBS[inf]?.pp || '?';
      return PRON.map((p, i) => conjugate(aux, 'pres')[i] + ' ' + pp);
    }
  }
  return PRON.map(() => '—');
}

function pluralNous(inf) {
  const V = VERBS[inf];
  if (V) return V.pres[3];
  const S = stemOfRegular(inf);
  if (S.type === 'er') return S.plural + 'ons';
  if (S.type === 'ir') return S.plural + 'ons';
  if (S.type === 're') return S.main + 'ons';
  return S.main + 'ons';
}

/* 预先建立「变位形式 → 原形」反查表，用于识别文本中的动词 */
const FORM_MAP = new Map();
const VERB_INF = new Set();   // 所有已知动词原形
(function buildFormMap() {
  const all = new Set(Object.keys(VERBS));
  Object.keys(DICT).forEach(w => { if (DICT[w].pos === 'v') all.add(w); });
  all.forEach(v => {
    VERB_INF.add(v);
    const seen = new Set();
    const push = (f) => {
      const clean = String(f).split(' ').pop().toLowerCase();
      if (clean && !seen.has(clean) && clean !== v && clean.length > 2) {
        seen.add(clean);
        if (!FORM_MAP.has(clean)) FORM_MAP.set(clean, v);
      }
    };
    TENSES.forEach(t => {
      try {
        conjugate(v, t.id).forEach(push);
        // être 作助动词时过去分词的四种配合形式（allé / allée / allés / allées）
        if (t.id === 'pc' && auxOf(v) === 'être') {
          const pp = conjugate(v, 'pc')[0].split(' ').pop();
          ['e', 's', 'es'].forEach(sfx => push(pp + sfx));
        }
      } catch (e) { /* 忽略个别异常动词 */ }
    });
  });
})();

/* ================= 词元还原 ================= */
function lemmaOf(w) {
  if (DICT[w]) return w;
  const acc = w.replace(/[’']/g, '');
  if (DICT[acc]) return acc;
  for (const suf of ['ées', 'ée', 'és', 's', 'x', 'inement']) {
    if (w.length > suf.length + 2 && w.endsWith(suf)) {
      const cand = w.slice(0, -suf.length);
      if (DICT[cand]) return cand;
      const cand2 = cand + 'e';
      if (DICT[cand2]) return cand2;
    }
  }
  return null;
}

/* ================= 考点抽取 ================= */
/* 数词（含 vingt-deux 这类组合）不参与词汇抽取 */
const NUM_WORDS = new Set('zero un deux trois quatre cinq six sept huit neuf dix onze douze treize quatorze quinze seize vingt trente quarante cinquante soixante quatre-vingts cent mille million milliard'.split(' '));
function isNumberWord(w) {
  const parts = String(w).split('-');
  return parts.length > 0 && parts.every(p => /^\d+$/.test(p) || NUM_WORDS.has(p) || /^(vingt|trente|quarante|cinquante|soixante)$/.test(p));
}

function extractVocab(text, opts = {}) {
  const toks = tokenize(text);
  const map = new Map();
  const sentList = sentences(text);
  // 统计每个词的「是否曾经句首大写出现过」，用于剔除人名地名
  const capStat = new Map();
  toks.forEach(t => {
    const w = t.w;
    const cur = capStat.get(w) || { total: 0, cap: 0 };
    cur.total++;
    if (/^[A-ZÀ-Þ]/.test(t.raw.replace(/^[^A-Za-zÀ-ÿ]*/, ''))) cur.cap++;
    capStat.set(w, cur);
  });
  toks.forEach(t => {
    const w = t.w;
    if (w.length < 3 || w.length > 26) return;
    if (/^\d+$/.test(w)) return;
    if (isNumberWord(w)) return;
    let lm = lemmaOf(w) || w;
    let info = DICT[lm] || null;
    let isVerb = VERB_INF.has(w) || (info && info.pos === 'v');
    if (!info && FORM_MAP.has(w)) {
      lm = FORM_MAP.get(w);
      info = DICT[lm] || null;
      isVerb = true;                       // 命中变位表 → 一定是动词，回填原形
    }
    if (FR_STOP.has(lm) || FR_STOP.has(w)) return;
    // 剔除专有名词：词典里没有，且此形式在文中出现过句首以外的大写
    if (!info) {
      const st = capStat.get(w);
      if (st && st.cap >= 1 && st.cap === st.total && !DICT[w]) return;
    }
    const k = lm;
    if (!map.has(k)) {
      map.set(k, {
        id: k, lemma: k, forms: new Set(), count: 0,
        pos: isVerb ? 'v' : (info?.pos || guessPos(lm)),
        level: info?.level || null,
        gender: info?.gender || null,
        zh: info?.zh || '',
        inDict: !!info,
        sent: [], inBundle: false
      });
    }
    const o = map.get(k);
    o.count++;
    o.forms.add(t.raw.toLowerCase());
  });
  // 给每个词配一句原文例句
  map.forEach(o => {
    const re = new RegExp('\\b' + o.lemma.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const hit = sentList.find(s => re.test(s));
    if (hit) o.sent = [hit];
  });
  const arr = [...map.values()];
  // CEFR 兜底：按频次与词长推断
  arr.forEach(o => {
    if (!o.level) {
      const rank = estimateRank(o);
      o.level = rankToLevel(rank, o.count);
      o.levelGuess = true;
    }
    if (!o.zh) o.zhGuess = true;
  });
  return arr.sort((a, b) => b.count - a.count);
}

function countStopLike(w) { return false; }

function estimateRank(o) {
  let score = 0;
  score += Math.min(o.count, 12) * 3;
  score += o.lemma.length <= 5 ? 8 : (o.lemma.length <= 8 ? 4 : 0);
  if (/ment$/.test(o.lemma)) score += 3;
  if (/tion$|sion$|té$|ité$/.test(o.lemma)) score += 2;
  return score;
}
function rankToLevel(score, count) {
  if (score >= 30) return 'A1';
  if (score >= 20) return 'A2';
  if (score >= 12) return 'B1';
  return 'B2';
}

function guessPos(w) {
  // 命中变位表的一律算动词，避免 appelle → adj 这类误判
  if (VERB_INF.has(w) || FORM_MAP.has(w)) return 'v';
  if (/(ment)$/.test(w) && w.length > 5) return 'adv';
  if (/(eux|euse|ique|able|ible|ain|el|al)$/.test(w)) return 'adj';
  if (/(tion|sion|té|ité|ance|ence|esse|ise|ude|ade|ie)$/.test(w)) return 'n';
  return 'n';
}

/* 语法点检测：按 DELF 常见考点做规则扫描 */
const GRAMMAR_RULES = [
  { id: 'pc', name: '复合过去时', re: /\b(ai|as|a|avons|avez|ont|suis|es|est|sommes|êtes|sont)\s+(\w+(é|é\(e\)|u|is|it|ert))\b/gi, level: 'A1' },
  { id: 'impar', name: '未完成过去时', re: /\b\w+(ais|ais|ait|ions|iez|aient)\b/gi, level: 'A2' },
  { id: 'futur', name: '简单将来时', re: /\b\w+(rai|ras|ra|rons|rez|ront)\b/gi, level: 'A2' },
  { id: 'cond', name: '条件式', re: /\b\w+(rais|rais|rait|rions|riez|raient)\b/gi, level: 'B1' },
  { id: 'subj', name: '虚拟式', re: /\bque\s+(il|elle|je|tu|nous|vous|ils|elles|on)\s+\w+(e|es|e|ions|iez|ent)\b/gi, level: 'B1' },
  { id: 'partitif', name: '部分冠词', re: /\b(du|de la|des)\s+\w+/gi, level: 'A1' },
  { id: 'negation', name: '否定结构', re: /\bne\s+\w+\s+(pas|plus|jamais|rien|personne|aucun)\b/gi, level: 'A1' },
  { id: 'relatif', name: '关系代词', re: /\b(qui|que|dont|où|lequel|laquelle|lesquels|lesquelles)\b/gi, level: 'A2' },
  { id: 'pronom', name: '宾语代词', re: /\b(je|tu|il|elle|nous|vous|ils|elles)\s+(le|la|les|lui|leur|y|en)\b/gi, level: 'A2' },
  { id: 'passif', name: '被动语态', re: /\b(est|sont|était|étaient|sera|seront)\s+\w+(é|ée|és|ées)\s+(par|de)\b/gi, level: 'B1' },
  { id: 'imperatif', name: '命令式', re: /^[^.?!]*\b(va|allons|allez|prends|prenons|prenez|viens|venons|venez)\b/gi, level: 'A2' },
  { id: 'gerondif', name: '副动词 / 现在分词', re: /\ben\s+\w+ant\b/gi, level: 'B1' },
  { id: 'pronominal', name: '代词式动词', re: /\b(je me|tu te|il se|elle se|nous nous|vous vous|ils se|elles se)\s+\w+/gi, level: 'A2' },
  { id: 'si', name: 'si 条件从句', re: /\bsi\s+\w+\s+(avais|avait|étais|était|ai|a|est)\b/gi, level: 'B1' },
  { id: 'futurproche', name: '最近将来时', re: /\b(vais|vas|va|allons|allez|vont)\s+\w+(er|ir|re|oir)\b/gi, level: 'A1' }
];

function extractGrammar(text) {
  return GRAMMAR_RULES.map(r => {
    const m = text.match(new RegExp(r.re.source, 'gi')) || [];
    return { id: r.id, name: r.name, level: r.level, count: m.length, samples: [...new Set(m.map(s => s.trim()))].slice(0, 3) };
  }).filter(g => g.count > 0).sort((a, b) => b.count - a.count);
}

/* ================= 易错点检测（启发式） ================= */
const ENGLISH_LEAK = new Set(['the','this','is','are','of','with','and','for','to','we','you','have','very','good','like','make','think','because','people','now','want','need','get','really','about','what','where','when','not','can','will','my','your']);

function detectSLA(text) {
  const issues = [];
  const toks = tokenize(text);
  const add = (id, snippet, extra) => issues.push({ id, snippet, extra: extra || '' });
  const known = new Set([...Object.keys(DICT), ...FR_STOP]);   // 免误报：la ≠ là
  const noAcc = new Map();
  Object.keys(DICT).forEach(w => { const s = stripAccents(w); if (s !== w && !noAcc.has(s) && !known.has(s)) noAcc.set(s, w); });

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], prev = toks[i - 1], next = toks[i + 1];
    // 1. 音符缺失
    if (noAcc.has(t.w) && !known.has(t.w)) add('accent', t.raw);
    // 2. 英语混入
    if (ENGLISH_LEAK.has(t.w)) add('english', t.raw, '疑似英语单词混入法语写作');
    // 3. 阴阳性：le/la + 已知名词
    if (prev && /^(le|la|un|une)$/.test(prev.w)) {
      const info = DICT[t.w];
      if (info && info.gender) {
        const expectM = /^(le|un)$/.test(prev.w);
        const actualM = info.gender === 'm';
        if (expectM !== actualM) add('genre', prev.raw + ' ' + t.raw, `应为 ${actualM ? 'le' : 'la'} ${t.w}`);
      }
    }
    // 4. a / à 混用： a 后接冠词或专有名词
    if (t.w === 'a' && next && /^(le|la|les|ma|mon|ta|ton|sa|son|notre|votre|leur|leur|ce|cette|cet|ces)$/.test(next.w)) {
      add('articles', prev ? prev.raw + ' a ' + next.raw : 'a ' + next.raw, '此处大概率应为介词 à');
    }
    // 5. de + le / de + les 未缩合
    if (t.w === 'de' && next && /^(le|les)$/.test(next.w)) add('de', 'de ' + next.raw, `应缩合为 ${next.w === 'le' ? 'du' : 'des'}`);
    // 6. que + 疑似变位动词（应为 qui）
    if (t.w === 'que' && next && FORM_MAP.has(next.w)) add('que_qui', 'que ' + next.raw, '关系代词后接变位动词时，通常应为 qui');
    // 7. suis/a + 过去分词 → 提示 être/avoir
    if (prev && /^(suis|es|est|sommes|êtes|sont)$/.test(prev.w) && FORM_MAP.has(t.w)) {
      const v = FORM_MAP.get(t.w);
      if (v && auxOf(v) === 'avoir') add('aux', prev.raw + ' ' + t.raw, `${v} 的复合过去时用 avoir 作助动词`);
    }
  }
  // 8. 口语省略 ne
  const oralNeg = text.match(/\b(j'ai|je|tu|il|elle|on|nous|vous|ils|elles)\s+(ai|as|a|avons|avez|ont|suis|es|est|sont)\s+pas\b/gi);
  (oralNeg || []).forEach(s => add('neg', s.trim(), '书面写作需补全 ne ... pas'));

  const grouped = {};
  issues.forEach(i => {
    if (!grouped[i.id]) grouped[i.id] = { id: i.id, count: 0, samples: [] };
    grouped[i.id].count++;
    if (grouped[i.id].samples.length < 4) grouped[i.id].samples.push(i.snippet + (i.extra ? '  — ' + i.extra : ''));
  });
  return Object.values(grouped).map(g => {
    const lib = SLA_LIB.find(s => s.id === g.id) || { name: g.id, level: '?', why: '', tip: '' };
    return { ...lib, ...g };
  }).sort((a, b) => b.count - a.count);
}

/* ================= 间隔重复调度（SM-2 简化版） ================= */
function initCard(lemma, data) {
  return {
    lemma, ...data, due: todayISO(), interval: 0, reps: 0, ef: 2.5, lapses: 0,
    history: [], suspended: false, added: Date.now()
  };
}
function todayISO(d) {
  const x = d ? new Date(d) : new Date();
  return x.toISOString().slice(0, 10);
}
function addDays(n, from) {
  const d = from ? new Date(from) : new Date();
  d.setDate(d.getDate() + n);
  return todayISO(d);
}
function review(card, quality) {
  // quality: 0 忘记 / 1 困难 / 2 一般 / 3 简单
  const q = Math.max(0, Math.min(3, quality));
  card.history.push({ t: Date.now(), q });
  card.reps++;
  if (q === 0) { card.lapses++; card.interval = 0; card.ef = Math.max(1.3, card.ef - 0.2); }
  else {
    if (card.interval === 0) card.interval = q === 1 ? 1 : (q === 2 ? 3 : 5);
    else card.interval = Math.round(card.interval * card.ef * (q === 1 ? 0.8 : q === 3 ? 1.3 : 1));
    card.ef = Math.max(1.3, card.ef + (0.1 - (3 - q) * (0.08 + (3 - q) * 0.02)));
  }
  card.due = addDays(Math.max(1, card.interval));
  return card;
}
function dueCards(cards) {
  const t = todayISO();
  return cards.filter(c => !c.suspended && c.due <= t);
}
function daysUntil(dateISO) {
  const a = new Date(todayISO()), b = new Date(dateISO);
  return Math.round((b - a) / 86400000);
}

/* ================= 受限文本生成（离线模板版） ================= */
const GEN_TEMPLATES = {
  A1: [
    "{Def} est vraiment {Adj}.",
    "J'ai {Ind} depuis deux ans.",
    "{Subj} {Vil} souvent le {Jour}.",
    "Il y a {Ind2} près de {Def2}."
  ],
  A2: [
    "Quand j'étais enfant, je {Vimparje} souvent dans {Def}.",
    "Hier, j'ai {Vpp} {Def2} parce qu'il était {Adj2}.",
    "Il faut que vous {Vsubjvous} avant {Time}.",
    "Si tu {Vsubjtu}, nous pourrons parler de {Def3}."
  ],
  B1: [
    "Bien que {Def} soit {Adj}, nous avons choisi {DE}{Vinf} dès le début.",
    "Il est essentiel que chacun {Vsubjil} {Ind} avant {Time}.",
    "Grâce {Adef2}, j'ai enfin pu {Vinf} sans difficulté.",
    "Avant {DE}{Vinf}, il aurait fallu prendre {Def3} au sérieux."
  ],
  B2: [
    "Force est de constater que {Def} demeure {Adj}, en dépit des efforts engagés.",
    "Encore faudrait-il que les autorités prennent {Def2} en considération.",
    "Quelles que soient les réserves émises à propos de {Def3}, la situation n'a guère évolué.",
    "Il n'est pas exclu que {Subj} finisse par {Vinf}, à condition d'en avoir les moyens."
  ]
};
const GEN_SLOT = {
  Subj: ['Mon frère', 'Ma voisine', 'Cet étudiant', 'Ma collègue'],
  Time: ['midi', 'huit heures', 'la fin du mois'],
  Jour: ['lundi', 'samedi', 'week-end'],
  NOUNS: [
    { w: 'quartier', gen: 'm' }, { w: 'maison', gen: 'f' }, { w: 'projet', gen: 'm' }, { w: 'ville', gen: 'f' },
    { w: 'travail', gen: 'm' }, { w: 'école', gen: 'f' }, { w: 'marché', gen: 'm' }, { w: 'lettre', gen: 'f' },
    { w: 'musée', gen: 'm' }, { w: 'rue', gen: 'f' }, { w: 'restaurant', gen: 'm' }, { w: 'université', gen: 'f' }
  ],
  ADJS: [{ w: 'difficile' }, { w: 'important' }, { w: 'intéressant' }, { w: 'passionnant' }, { w: 'simple' }],
  VERBS: ['travailler', 'voyager', 'choisir', 'réussir', 'préparer', 'comprendre']
};
/* 省音 + 性数配合：给定名词与冠词类型，返回正确形式 */
const VOWEL = /^[aeiouyàâäéèêëîïôöùûüh]/i;
function article(kind, word, gender) {
  const w = String(word);
  if (kind === 'du') {                                   // de + le / l'
    return (VOWEL.test(w) ? "de l'" : 'du ') + w;
  }
  if (kind === 'part') {                                 // du / de la / de l'
    return (VOWEL.test(w) ? "de l'" : (gender === 'f' ? 'de la ' : 'du ')) + w;
  }
  if (kind === 'ind') {                                  // un / une
    return (gender === 'f' ? 'une ' : 'un ') + w;
  }
  if (kind === 'dem') {                                  // ce / cet / cette
    if (gender === 'f') return 'cette ' + w;
    return (VOWEL.test(w) ? 'cet ' : 'ce ') + w;
  }
  if (kind === 'a') {                                    // à + le/la/les/l' → au / aux
    return (VOWEL.test(w) ? "à l'" : (gender === 'f' ? 'à la ' : 'au ')) + w;
  }
  if (kind === 'de') {                                   // de + voyelle → d'
    return (VOWEL.test(w) ? "d'" : 'de ') + w;
  }
  // défini
  if (VOWEL.test(w)) return "l'" + w;
  return (gender === 'f' ? 'la ' : 'le ') + w;
}
function agreeAdj(adj, gender, plural) {
  let a = String(adj);
  if (gender === 'f') a += 'e';
  if (plural) a += 's';
  return a;
}
function shuffleIdx(n) { const a = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function isPluralish(w) { return /(s|x|z)$/.test(String(w)) && !/(ais|ois|és)$/.test(w); }

function genPassage(level, vocab, targetGrammar, n = 3) {
  const tpls = GEN_TEMPLATES[level] || GEN_TEMPLATES.A2;
  const usable = (x, pos) => x.pos === pos && /^[a-zà-ÿ]/.test(x.lemma) && x.lemma.length < 18 && !/\s/.test(x.lemma);
  // 单数名词槽不用复数名词（否则会出 le dimanches 这种东西）
  const singular = x => !/(s|x|z)$/.test(x.lemma) && !/^(vacances|gens)$/.test(x.lemma);
  const nounsIn = vocab.filter(x => usable(x, 'n') && singular(x));
  const verbsIn = vocab.filter(x => usable(x, 'v'));
  const adjsIn = vocab.filter(x => usable(x, 'adj'));
  const pickNoun = () => {
    if (nounsIn.length) {
      const x = nounsIn[Math.floor(Math.random() * nounsIn.length)];
      return { w: x.lemma, gen: x.gender || (/[eé]$/.test(x.lemma) ? 'f' : 'm') };
    }
    return GEN_SLOT.NOUNS[Math.floor(Math.random() * GEN_SLOT.NOUNS.length)];
  };
  const pickAdj = () => (adjsIn.length ? { w: adjsIn[Math.floor(Math.random() * adjsIn.length)].lemma } : GEN_SLOT.ADJS[Math.floor(Math.random() * GEN_SLOT.ADJS.length)]);
  const pickVerb = () => (verbsIn.length ? verbsIn[Math.floor(Math.random() * verbsIn.length)].lemma : GEN_SLOT.VERBS[Math.floor(Math.random() * GEN_SLOT.VERBS.length)]);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const safe = (fn, dflt) => { try { const v = fn(); return /undefined|—|^$/.test(v) ? dflt : v; } catch (e) { return dflt; } };

  const out = [], recycled = [];
  const order = shuffleIdx(tpls.length);
  for (let i = 0; i < n; i++) {
    let s = tpls[order[i % tpls.length]];
    const N1 = pickNoun(), N2 = pickNoun(), N3 = pickNoun();
    const A1 = pickAdj(), A2 = pickAdj(), V = pickVerb();
    recycled.push(N1.w, N2.w, V);
    const map = {
      Def: article('def', N1.w, N1.gen), Def2: article('def', N2.w, N2.gen), Def3: article('def', N3.w, N3.gen),
      Ind: article('ind', N1.w, N1.gen), Ind2: article('ind', N2.w, N2.gen),
      Part: article('part', N1.w, N1.gen),
      Adef: article('a', N1.w, N1.gen), Adef2: article('a', N2.w, N2.gen),
      DE: VOWEL.test(V) ? "d'" : 'de ',
      Adj: agreeAdj(A1.w, N1.gen), Adj2: agreeAdj(A2.w, N2.gen),
      Subj: pick(GEN_SLOT.Subj), Time: pick(GEN_SLOT.Time), Jour: pick(GEN_SLOT.Jour),
      Vil: safe(() => conjugate(V, 'pres')[2], 'travaille'),
      Vimparje: safe(() => conjugate(V, 'impar')[0], 'travaillais'),
      Vsubjvous: safe(() => conjugate(V, 'subj')[4], 'choisissiez'),
      Vsubjtu: safe(() => conjugate(V, 'subj')[1], 'choisisses'),
      Vsubjil: safe(() => conjugate(V, 'subj')[2], 'choisisse'),
      Vpp: safe(() => (VERBS[V] ? VERBS[V].pp : ppOfRegular(V)) || 'préparé', 'préparé'),
      Vinf: V
    };
    s = s.replace(/\{(\w+)\}/g, (m, k) => (map[k] !== undefined ? map[k] : m));
    out.push(s.replace(/\s+/g, ' ').trim());
  }
  return {
    text: out.join(' '),
    note: '离线模板生成：句式为受控结构，所有名词都做了省音与阴阳性处理，词汇优先取自你导入的材料。接入 API 后替换为真正的受限生成——由模型保证目标词在上下文里自然复现。',
    recycled: [...new Set(recycled)],
    targets: targetGrammar?.slice(0, 2).map(g => g.name) || []
  };
}

/* ================= 存储 ================= */
const LS_KEY = 'allez_v1';
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}
function saveState(s) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
    return true;
  } catch (e) {
    /* 配额超限通常是大 PDF 的正文撑爆了 localStorage（上限约 5 MB）。
       丢掉 rawText 再存一次——复习进度和卡片比原文重要得多。 */
    try {
      const slim = Object.assign({}, s, { rawText: '' });
      localStorage.setItem(LS_KEY, JSON.stringify(slim));
      if (typeof window !== 'undefined' && window.notifyStorageTrim) window.notifyStorageTrim();
      return false;
    } catch (e2) { return false; }
  }
}

/* ================= TTS ================= */
function speak(text, rate) {
  if (!('speechSynthesis' in window)) return false;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    u.rate = rate || 0.9;
    const v = window.speechSynthesis.getVoices().find(v => /fr[-_]?FR|French/i.test(v.lang + v.name));
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
    return true;
  } catch (e) { return false; }
}
if ('speechSynthesis' in window) { window.speechSynthesis.getVoices(); }

/* ================= 答案比对 ================= */
function normAns(s) {
  return stripAccents(String(s)).toLowerCase()
    .replace(/[’'ʼ`·.,!?;:"()]/g, '').replace(/\s+/g, '').trim();
}
function gradeAnswer(user, expect) {
  const a = normAns(user), b = normAns(expect);
  if (!a) return { ok: false, msg: '请填写作答' };
  if (a === b) {
    return { ok: true, msg: '正确', note: stripAccents(expect) !== expect ? '请注意音符：' + expect : '' };
  }
  if (stripAccents(expect).toLowerCase() !== expect.toLowerCase() && a === stripAccents(expect).toLowerCase().trim()) {
    return { ok: false, msg: '只差音符', note: '正确写法：' + expect };
  }
  return { ok: false, msg: '不正确', note: '参考答案：' + expect };
}
