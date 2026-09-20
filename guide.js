/* =========================================================================
   guide.js — 首次使用引导 + 常驻使用指南
   -------------------------------------------------------------------------
   第一次打开会弹一个 5 步引导（localStorage 记住，只在真的没用过时弹）。
   之后任何时候点顶部「指南」都能再看。
   ========================================================================= */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const ONBOARD_KEY = 'allez.onboarded.v1';

  /* ---------------- 首次引导的 5 步 ---------------- */
  const STEPS = [
    {
      t: '这不是又一个背单词 App',
      h: '通用语言学习工具的问题是不认你的考试',
      b: '它只做一件事：把你这学期的材料拆成考点，按遗忘曲线排出每天该做的事，直到你考过。' +
        '全程在你自己的浏览器里跑，材料不上传任何服务器。',
      tip: '先花 60 秒走完这 5 步。'
    },
    {
      t: '第 1 步 · 倒入你的材料',
      h: '材料越贴近真实考试，抽出来的考点越准',
      b: '把讲义、教材课文、词汇表、历年真题粘贴进来，或者直接把 PDF 拖进来 —— 扫描件也能处理（会走 OCR）。' +
        '如果一时拿不准放什么，先点「载入示例课文」把整条流程跑一遍。',
      tip: '一份 2–3 页的课文就够跑通。别一上来塞整本书。'
    },
    {
      t: '第 2 步 · 挑出要背的',
      h: '别全选，先 50 个',
      b: '解析完会给出一张考点表，标了词频、CEFR 等级、以及这个词在你材料里的原句。' +
        '点「加入最高频 50 个」就够了 —— 背完再加下一批，比一次塞 500 个然后放弃强得多。',
      tip: '带原句的例句比孤立单词好记，因为那句话是你自己的语境。'
    },
    {
      t: '第 3 步 · 每天 20 分钟',
      h: '六种模式轮着来，别只刷一种',
      b: '认·形义、认·听力、用·完形、用·变位、生·输出、读·受限输入。' +
        '间隔重复算法会决定每张卡下一次什么时候再问你 —— 到「排课」页看今天到期哪些。',
      tip: '「用·变位」是最值钱的一个，法语丢分大头在动词形态。'
    },
    {
      t: '第 4 步 · 看自己还差多少',
      h: '验收 + 易错点',
      b: '「验收」页给能力雷达和考纲覆盖度；「易错点」页列的是中文母语者系统性会栽的地方 —— ' +
        '阴阳性、性数配合、虚拟式、代词位置、部分冠词。这才是这个工具真正针对性的部分。',
      tip: '最后去「设置」填一个 API Key：中文释义和受限阅读会立刻好一个档次。不填也能用。'
    }
  ];

  function renderModal(step) {
    const s = STEPS[step];
    return `
      <div class="gstep">${step + 1} / ${STEPS.length}</div>
      <h3 class="gtitle">${s.t}</h3>
      <div class="ghead">${s.h}</div>
      <p class="gbody">${s.b}</p>
      <div class="gtip">${s.tip}</div>
      <div class="gdots">${STEPS.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('')}</div>`;
  }

  let cur = 0, backdrop = null;

  function close() {
    if (backdrop) backdrop.remove();
    backdrop = null;
    try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) { /* 隐私模式 */ }
  }

  function openOnboarding(force) {
    if (!force) {
      try { if (localStorage.getItem(ONBOARD_KEY)) return; } catch (e) { /* 读不到就当没看过 */ }
    }
    if (backdrop) return;
    cur = 0;
    backdrop = document.createElement('div');
    backdrop.className = 'modal-back';
    backdrop.innerHTML = `
      <div class="modal">
        <div class="modal-body" id="obBody"></div>
        <div class="modal-foot">
          <button class="btn ghost" id="obSkip">跳过</button>
          <span style="flex:1"></span>
          <button class="btn" id="obPrev">上一步</button>
          <button class="btn pri" id="obNext">下一步</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const body = backdrop.querySelector('#obBody');
    const prev = backdrop.querySelector('#obPrev');
    const next = backdrop.querySelector('#obNext');
    const sync = () => {
      body.innerHTML = renderModal(cur);
      prev.disabled = cur === 0;
      next.textContent = cur === STEPS.length - 1 ? '开始用' : '下一步';
    };
    sync();
    prev.onclick = () => { if (cur > 0) { cur--; sync(); } };
    next.onclick = () => {
      if (cur === STEPS.length - 1) { close(); if (typeof switchTab === 'function') switchTab('import'); }
      else { cur++; sync(); }
    };
    backdrop.querySelector('#obSkip').onclick = close;
    backdrop.onclick = e => { if (e.target === backdrop) close(); };
  }

  /* ---------------- 常驻指南页 ---------------- */
  const GUIDE_HTML = `
  <div class="card">
    <h2>60 秒上手</h2>
    <p class="sub">按顺序走一遍这四步，之后每天只需要打开「排课」看今天到期什么。</p>
    <ol class="gsteps">
      <li><b>导入</b> —— 粘贴法语原文，或把 PDF／图片拖进来。选目标等级和考试日期。</li>
      <li><b>考点</b> —— 点「解析」，勾掉已经会的，加入最高频的 50 个。</li>
      <li><b>训练</b> —— 六种模式轮着刷。到期没到的卡片不会烦你，到期的才会。</li>
      <li><b>验收</b> —— 看雷达图和考纲覆盖度，缺哪块补哪块。</li>
    </ol>
    <div class="row" style="margin-top:14px">
      <button class="btn pri" id="gStart">载入示例课文，直接体验</button>
      <button class="btn" id="gReplay">重看首次引导</button>
    </div>
  </div>

  <div class="card">
    <h2>六种练习模式各自练什么</h2>
    <p class="sub">别只刷第一种。认得出 ≠ 用得出，这是两回事。</p>
    <div class="gmode"><b>认 · 形义</b><span>法语词 → 选中文。最基础，用来建立第一次接触。</span></div>
    <div class="gmode"><b>认 · 听力</b><span>听音选形。用浏览器自带法语合成，正式版建议换 Azure 神经语音。</span></div>
    <div class="gmode"><b>用 · 完形</b><span>从你自己的材料里挖空。语境是你熟悉的，所以记得住。</span></div>
    <div class="gmode"><b>用 · 变位</b><span>动词变位填空。法语丢分大头，值得单独练。</span></div>
    <div class="gmode"><b>生 · 输出</b><span>给中文让你写法语。离线版只做规则检查，接模型后是 CEFR 级批改。</span></div>
    <div class="gmode"><b>读 · 受限输入</b><span>只用「你已会的词 + 今天这一个点」生成的短文，配音频。</span></div>
  </div>

  <div class="card">
    <h2>材料怎么选（这一条决定效果上限）</h2>
    <p class="sub">系统的产出质量直接等于你喂进去的东西的质量。</p>
    <div class="gmode ok"><b>最好</b><span>近三年真题阅读、你这学期的讲义、老师发的词汇表</span></div>
    <div class="gmode ok"><b>不错</b><span>教材课文（ACLE / 北外《法语》/ Alter Ego 都行）、备考书范文</span></div>
    <div class="gmode warn"><b>一般</b><span>泛读材料、新闻。词汇面太散，抽出来的考点跟考试重合度低</span></div>
    <div class="gmode bad"><b>别用</b><span>中法对照的双语对照表。法语部分会被中文打断，断句全乱</span></div>
    <div class="hint">建议：3–5 份同级别材料一起导入，重合出现的词就是高频考点。</div>
  </div>

  <div class="card">
    <h2>扫描件和图片怎么办（OCR）</h2>
    <p class="sub">拖进来的 PDF 如果没有文本层，会自动弹出 OCR 面板。</p>
    <div class="note" style="margin-bottom:12px">
      扫描件的识别质量取决于原图。拍得正、光线匀、300 dpi 左右最好；倾斜、手指遮挡、摩尔纹都会让识别率断崖式下跌。
    </div>
    <div class="gmode"><b>视觉大模型</b><span>质量最好，尤其擅长法语重音和省音（é / è / ê / ç / œ）。需要 API Key，图片会发给你配置的接口。</span></div>
    <div class="gmode"><b>Tesseract.js</b><span>在你浏览器本地跑，图片不出本机。首次需要从 CDN 下载约 15 MB 模型，之后会缓存。识别率低于视觉模型，重音容易丢。</span></div>
    <div class="gmode warn"><b>JPEG 2000 不支持</b><span>少数扫描仪输出 JPXDecode 压缩，浏览器解不了。遇到会明确提示你，用系统预览重新导出一份 JPEG 即可。</span></div>
    <div class="hint">识别完会自动做一遍法语后处理：合并被换行切断的单词、统一引号、展开连字符。但丢掉的重音补不回来 —— 所以尽量用视觉模型。</div>
  </div>

  <div class="card">
    <h2>接了模型之后会强在哪</h2>
    <p class="sub">不接也能用，离线规则引擎负责抽词、分级、变位和易错点检测。</p>
    <div class="gmode"><b>中文释义</b><span>贴合你材料里那个语境的义项，而不是词典冷冰冰的第一条</span></div>
    <div class="gmode"><b>受限文本生成</b><span>真的控制在「已学词汇 + i+1」范围内的法语短文。这是词汇自然复现的关键，也是最难被抄的部分</span></div>
    <div class="gmode"><b>写作批改</b><span>对你主动输出的法语做 CEFR 级批改：语法、性数配合、语体</span></div>
    <div class="gmode"><b>OCR</b><span>扫描件转文字，重音还原远好于本地引擎</span></div>
    <div class="hint">Key 只存在你的浏览器 localStorage，请求直接打到你填的接口地址，不经过任何中转。</div>
  </div>

  <div class="card">
    <h2>常见问题</h2>
    <details><summary>数据存在哪？换设备还在吗？</summary>
      <p class="mut" style="margin-top:8px">存在当前浏览器的 localStorage 里，不同设备、不同浏览器之间不互通，清缓存会丢。<b>到「设置」→「数据备份」导出一份 JSON</b>，换设备时再导入就行；别指望云服务帮你兜底，这里没有云。「排课」页另有「导出 Anki CSV」，想在 Anki 里一起背可以用它。</p></details>
    <details><summary>为什么很多词没有中文释义？</summary>
      <p class="mut" style="margin-top:8px">内置离线词库只有约 400 条核心词。接上 API Key 之后会自动补齐，并校准 CEFR 等级。</p></details>
    <details><summary>PDF 有大小限制吗？</summary>
      <p class="mut" style="margin-top:8px">100 MB 硬拒（再大浏览器会卡死），25 MB / 200 页起会提示你等一等。提取出的正文截到 40 万字符，超过这个量对背单词没意义。</p></details>
    <details><summary>扫描件 OCR 结果很差怎么办？</summary>
      <p class="mut" style="margin-top:8px">先看是不是 JPXDecode（会明确提示）。不是的话换个引擎试试，视觉模型对重音的处理明显更好。也可以只 OCR 前几页先验证效果。</p></details>
    <details><summary>怎么把生词带回 Anki？</summary>
      <p class="mut" style="margin-top:8px">「排课」页有「导出 Anki CSV」，导入时字段选「正面 / 背面」即可。</p></details>
  </div>

  <div class="card">
    <h2>现在还做不到的事</h2>
    <p class="sub">与其让你自己撞墙，不如先说清楚。</p>
    <div class="gmode bad"><b>主动输出只有规则检查</b><span>没接模型时，只能查音符缺失、英文混入、冠词配合这几类，做不了真正的语法批改</span></div>
    <div class="gmode bad"><b>受限阅读是模板生成</b><span>语法保证正确，但语义是机械的，读起来不像人写的</span></div>
    <div class="gmode bad"><b>用的是 SM-2</b><span>Anki 的 FSRS 对「今天只有 12 分钟」这种现实约束友好得多，正式版建议换掉</span></div>
    <div class="gmode bad"><b>纯扫描件无法还原版面</b><span>双栏、表格、页眉页脚混排的文档，OCR 出来的顺序可能是乱的</span></div>
  </div>`;

  function render() {
    const el = $('#guideBody');
    if (!el || el.dataset.done) return;
    el.innerHTML = GUIDE_HTML;
    el.dataset.done = '1';
    const start = $('#gStart');
    if (start) start.onclick = () => {
      const s = $('#loadSample'); if (s) s.click();
      if (typeof switchTab === 'function') switchTab('import');
    };
    const replay = $('#gReplay');
    if (replay) replay.onclick = () => openOnboarding(true);
  }

  window.Guide = { open: () => openOnboarding(true), render, close };

  // 首次打开自动弹一次；已经导入过材料的老用户不打扰
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(maybe, 400));
  } else { setTimeout(maybe, 400); }
  function maybe() {
    let used = false;
    try {
      used = !!(localStorage.getItem('allez_v1') || '').match(/"vocab":\[\s*\{/);
    } catch (e) { /* 忽略 */ }
    if (used) { try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) { /* 忽略 */ } return; }
    openOnboarding(false);
  }
})();
