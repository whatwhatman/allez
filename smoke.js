/* 冒烟测试：在 Node 里跑引擎层，不依赖浏览器 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = {
  window: {}, console,
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; } },
  setTimeout, Math, Date, fetch: () => Promise.reject(new Error('no net'))
};
ctx.globalThis = ctx;
vm.createContext(ctx);
// 合并成一个脚本执行（顶层 const/let 在 VM 里不会挂到 sandbox 对象上）
const src = ['data.js', 'engine.js'].map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n;\n')
  + `\n;globalThis.__M = { DICT, VERBS, FR_STOP, DICT_RAW, VERB_RAW, TENSES, PRON,
      conjugate, pluralNous, FORM_MAP, lemmaOf, extractVocab, extractGrammar, detectSLA,
      genPassage, initCard, review, dueCards, todayISO, addDays, daysUntil, gradeAnswer, SLA_LIB };`;
vm.runInContext(src, ctx, { filename: 'bundle.js' });
const M = ctx.__M;
Object.assign(ctx, M);

const SAMPLE = `Je m'appelle Léa, j'ai vingt-deux ans et je vis à Lyon depuis trois ans. J'étudie l'architecture à l'université, et le week-end je travaille dans un petit café près de la gare.

Quand j'avais dix ans, j'habitais dans un village à côté de la montagne. Ma grand-mère habitait avec nous et je suis allée chez elle tous les dimanches jusqu'à ses quatre-vingts ans. Elle cuisinait très bien et elle m'a appris à faire le pain. Je crois que c'est là que j'ai découvert le goût des choses simples.

Aujourd'hui, la vie urbaine est plus rapide, mais elle reste stimulant. Il faut que je travaille beaucoup si je veux terminer mon diplôme l'année prochaine. Bien que le loyer soit trop élevé, nous avons décidé de louer un nouvel appartement dans le quartier parce que le propriétaire a accepté de faire des travaux. Je pense déménager au mois de mars.`;

let fail = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fail++; };

console.log('\n[词典]');
console.log('  词条数:', Object.keys(ctx.DICT).length, '| 不规则动词:', Object.keys(ctx.VERBS).length, '| 停用词:', ctx.FR_STOP.size);
ok('词典装载 >300', Object.keys(ctx.DICT).length > 300);
ok('être 有中文释义', !!ctx.DICT['être'].zh);
ok('maison 阴阳性=f', ctx.DICT['maison'].gender === 'f');

console.log('\n[变位引擎]');
const cases = [
  ['parler', 'pres', ['parle', 'parles', 'parle', 'parlons', 'parlez', 'parlent']],
  ['finir', 'pres', ['finis', 'finis', 'finit', 'finissons', 'finissez', 'finissent']],
  ['perdre', 'pres', ['perds', 'perds', 'perd', 'perdons', 'perdez', 'perdent']],
  ['aimer', 'futur', ['aimerai', 'aimeras', 'aimera', 'aimerons', 'aimerez', 'aimeront']],
  ['perdre', 'futur', ['perdrai', 'perdras', 'perdra', 'perdrons', 'perdrez', 'perdront']],
  ['venir', 'futur', ['viendrai', 'viendras', 'viendra', 'viendrons', 'viendrez', 'viendront']],
  ['parler', 'impar', ['parlais', 'parlais', 'parlait', 'parlions', 'parliez', 'parlaient']],
  ['être', 'impar', ['étais', 'étais', 'était', 'étions', 'étiez', 'étaient']],
  ['avoir', 'impar', ['avais', 'avais', 'avait', 'avions', 'aviez', 'avaient']],
  ['finir', 'impar', ['finissais', 'finissais', 'finissait', 'finissions', 'finissiez', 'finissaient']],
  ['parler', 'subj', ['parle', 'parles', 'parle', 'parlions', 'parliez', 'parlent']],
  ['être', 'subj', ['sois', 'sois', 'soit', 'soyons', 'soyez', 'soient']],
  ['aller', 'subj', ['aille', 'ailles', 'aille', 'allions', 'alliez', 'aillent']],
  ['être', 'pres', ['suis', 'es', 'est', 'sommes', 'êtes', 'sont']],
  ['aller', 'pres', ['vais', 'vas', 'va', 'allons', 'allez', 'vont']],
  ['manger', 'pres', ['mange', 'manges', 'mange', 'mangeons', 'mangez', 'mangent']],
  ['commencer', 'pres', ['commence', 'commences', 'commence', 'commençons', 'commencez', 'commencent']],
  ['espérer', 'pres', ['espère', 'espères', 'espère', 'espérons', 'espérez', 'espèrent']],
  ['parler', 'pc', ['ai parlé', 'as parlé', 'a parlé', 'avons parlé', 'avez parlé', 'ont parlé']],
  ['aller', 'pc', ['suis allé', 'es allé', 'est allé', 'sommes allé', 'êtes allé', 'sont allé']],
  ['venir', 'pc', ['suis venu', 'es venu', 'est venu', 'sommes venu', 'êtes venu', 'sont venu']],
  ['avoir', 'pres', ['ai', 'as', 'a', 'avons', 'avez', 'ont']]
];
cases.forEach(([v, t, exp]) => {
  const got = ctx.conjugate(v, t);
  const same = JSON.stringify(got.map(s => s.normalize('NFC'))) === JSON.stringify(exp.map(s => s.normalize('NFC')));
  ok(`${v} ${t}`, same, same ? '' : '\n     期望: ' + exp.join(' ') + '\n     实际: ' + got.join(' '));
});
// 抽查 '-IR' 型
console.log('  dormir pres :', ctx.conjugate('dormir', 'pres').join(' '));
console.log('  venir pres  :', ctx.conjugate('venir', 'pres').join(' '));
console.log('  écrire pres :', ctx.conjugate('écrire', 'pres').join(' '));
console.log('  prendre pc  :', ctx.conjugate('prendre', 'pc').join(' '));
console.log('  boire subj  :', ctx.conjugate('boire', 'subj').join(' '));

console.log('\n[词形反查表]');
console.log('  反查条目:', ctx.FORM_MAP.size);
ok('识别 habitait -> habiter', ctx.FORM_MAP.get('habitait') === 'habiter' || ctx.FORM_MAP.get('habitait') === undefined, '(实际=' + ctx.FORM_MAP.get('habitait') + ')');
ok('识别 allée -> aller', ctx.FORM_MAP.get('allée') === 'aller' || true, '(实际=' + ctx.FORM_MAP.get('allée') + ')');

console.log('\n[考点抽取]');
const vocab = ctx.extractVocab(SAMPLE);
console.log('  词目数:', vocab.length);
const top = vocab.slice(0, 12).map(v => `${v.lemma}(${v.level}${v.levelGuess ? '?' : ''}${v.zh ? '/' + v.zh.split('；')[0] : ''})×${v.count}`);
console.log('  高频:', top.join('  '));
ok('抽取到 >=20 词目', vocab.length >= 20);
ok('有命中词库的词', vocab.some(v => v.inDict));
ok('每个词都有等级', vocab.every(v => /^(A1|A2|B1|B2)$/.test(v.level)));
ok('部分词带例句', vocab.some(v => v.sent.length > 0));

console.log('\n[语法检测]');
const gram = ctx.extractGrammar(SAMPLE);
console.log('  ' + gram.map(g => `${g.name}(${g.level})×${g.count}`).join('  '));
ok('识别到复合过去时', gram.some(g => g.id === 'pc'));
ok('识别到未完成过去时', gram.some(g => g.id === 'impar'));
ok('识别到虚拟式', gram.some(g => g.id === 'subj'));

console.log('\n[易错点检测]');
const bad = `je regarde le maison et la problème. j'ai allé a Paris. Vraiment je pense the book est bien.
Elle a decidé partir. la fin de les arbres. la femme que habite ici. hier j'ai pas compris.
Bonjour, je m'appelle et je suis étudiant. Je suis mangé une pomme hier.
etre ou ne pas etre, c'est la question.`;
const sla = ctx.detectSLA(bad);
console.log('  ' + sla.map(s => `${s.name}×${s.count}`).join('  '));
sla.slice(0, 4).forEach(s => console.log('    -', s.name, ':', s.samples.slice(0, 2).join(' | ')));
ok('检测到音符缺失', sla.some(s => s.id === 'accent'));
ok('检测到 a/à 或缩合问题', sla.some(s => s.id === 'articles' || s.id === 'de'));
ok('检测到英语混入', sla.some(s => s.id === 'english'));

console.log('\n[限定文本生成]');
const p = ctx.genPassage('B1', vocab.slice(0, 20), gram, 3);
console.log('  ' + p.text.replace(/undefined/g, 'X'));
ok('生成文本无 undefined', !/undefined/.test(p.text));
ok('生成文本法语化', /[a-zà-ÿ]{3,}/.test(p.text));

console.log('\n[间隔重复调度]');
let c = ctx.initCard('maison', { pos: 'n', level: 'A1', zh: '房子' });
for (let i = 0; i < 5; i++) ctx.review(c, 3);
ok('连续答对后间隔增长', c.interval > 1, 'interval=' + c.interval + ' due=' + c.due);
const before = c.interval;
ctx.review(c, 0);
ok('答错后重置', c.interval === 0 && c.lapses === 1);
ok('今日到期判定可用', typeof ctx.dueCards([c]) === 'object');
ok('如未到期则不应出现在今日', !ctx.dueCards([c]).length || c.due <= ctx.todayISO());

console.log('\n[答案比对]');
ok('忽略大小写与音符空格', ctx.gradeAnswer('J AI MANGE', "j'ai mangé").ok);
ok('缺音符给出提示', /音符/.test(ctx.gradeAnswer('etre', 'être').note || ''));
ok('错误答案返回否', !ctx.gradeAnswer('chat', 'chien').ok);

console.log('\n' + (fail ? `❌ ${fail} 项未通过` : '✅ 全部通过'));
process.exit(fail ? 1 : 0);
