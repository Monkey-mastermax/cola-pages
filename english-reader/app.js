/* 精读台 · app.js
 * 朗读：Web Speech API（浏览器自带语音引擎）
 * 翻译：MyMemory 免费接口（默认）或自定义 OpenAI 兼容接口
 * 词典：dictionaryapi.dev（音标 / 英文释义 / 真人音频）
 * 语法：本地规则引擎（启发式，界面上明确标注）
 * 固定搭配：内置约 340 条搭配库，匹配时自动标注
 */
(function () {
  'use strict';

  const DATA = window.COLA_DATA || { collocations: [], samples: [] };
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ============================ 存储 ============================ */
  const LS = {
    get(k, d) {
      try {
        const v = localStorage.getItem('jingdu.' + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem('jingdu.' + k, JSON.stringify(v)); } catch (e) {}
    },
  };

  const state = {
    title: LS.get('title', ''),
    sentences: [],
    current: -1,
    playing: false,
    speakSeq: 0,
    rate: LS.get('rate', 0.9),
    voiceURI: LS.get('voiceURI', ''),
    bilingual: LS.get('bilingual', true),
    dictation: false,
    courseTier: LS.get('courseTier', 'primary'),
    courseOnly: LS.get('courseOnly', true),
    provider: LS.get('provider', 'mymemory'),
    ai: LS.get('ai', { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: '' }),
    words: LS.get('words', []),
    wordCache: LS.get('wordCache3', {}),
    analysis: {},          // index -> {translation, grammar, collocs, source}
    tcache: {},            // text -> translation
    cardWord: null,
    noEnglish: false,      // 浏览器/系统没有英文语音包
  };
  let NET_FAIL = false;    // 联网翻译/词典接口连不上（离线或被墙）
  let netBannerOpen = false;

  /* ============================ 工具 ============================ */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function attr(s) { return esc(s); }
  function decodeEntities(s) {
    const el = document.createElement('textarea');
    el.innerHTML = s;
    return el.value;
  }
  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2600);
  }

  // 联网失败横幅：只弹一次，避免 13 个句子排队全失败时刷屏
  function showNetBanner(msg) {
    const b = document.getElementById('status-banner');
    if (!b) return;
    b.classList.remove('hidden');
    b.classList.add('error');
    b.innerHTML =
      '<span>' + esc(msg) + '</span>' +
      '<button id="banner-retry" class="banner-btn">重试</button>' +
      '<button id="banner-ai" class="banner-btn ghost">用自定义 AI</button>' +
      '<button id="banner-close" class="banner-x">✕</button>';
    const r = document.getElementById('banner-retry');
    if (r) r.onclick = () => {
      NET_FAIL = false; netBannerOpen = false; b.classList.add('hidden');
      if (state.bilingual && state.sentences.length) {
        ensureSentenceTranslation(state.current >= 0 ? state.current : 0);
      }
    };
    const a = document.getElementById('banner-ai');
    if (a) a.onclick = () => { syncSettingsUI(); openModal('modal-settings'); };
    const x = document.getElementById('banner-close');
    if (x) x.onclick = () => { b.classList.add('hidden'); };
  }
  function markNetFail(reason) {
    NET_FAIL = true;
    if (!netBannerOpen) { netBannerOpen = true; showNetBanner(reason); }
  }

  // 带超时的 JSON 请求：避免一个挂死的请求把整个翻译队列堵住
  async function fetchJSON(url, opts, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 9000);
    try {
      const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
      if (!r.ok) {
        const e = new Error('HTTP ' + r.status);
        e.status = r.status;
        throw e;
      }
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /* ============================ 固定搭配库 ============================ */
  // 不规则变化表（短语首词）
  const IRR = {
    be: ['is', 'are', 'am', 'was', 'were', 'been', 'being'],
    break: ['breaks', 'broke', 'broken', 'breaking'],
    bring: ['brings', 'brought', 'bringing'],
    buy: ['buys', 'bought', 'buying'],
    catch: ['catches', 'caught', 'catching'],
    choose: ['chooses', 'chose', 'chosen', 'choosing'],
    come: ['comes', 'came', 'coming'],
    cost: ['costs', 'cost', 'costing'],
    cut: ['cuts', 'cut', 'cutting'],
    deal: ['deals', 'dealt', 'dealing'],
    do: ['does', 'did', 'done', 'doing'],
    draw: ['draws', 'drew', 'drawn', 'drawing'],
    drive: ['drives', 'drove', 'driven', 'driving'],
    eat: ['eats', 'ate', 'eaten', 'eating'],
    fall: ['falls', 'fell', 'fallen', 'falling'],
    feed: ['feeds', 'fed', 'feeding'],
    feel: ['feels', 'felt', 'feeling'],
    fight: ['fights', 'fought', 'fighting'],
    find: ['finds', 'found', 'finding'],
    fit: ['fits', 'fit', 'fitting'],
    forget: ['forgets', 'forgot', 'forgotten', 'forgetting'],
    get: ['gets', 'got', 'gotten', 'getting'],
    give: ['gives', 'gave', 'given', 'giving'],
    go: ['goes', 'went', 'gone', 'going'],
    grow: ['grows', 'grew', 'grown', 'growing'],
    hang: ['hangs', 'hung', 'hanging'],
    have: ['has', 'had', 'having'],
    hear: ['hears', 'heard', 'hearing'],
    hide: ['hides', 'hid', 'hidden', 'hiding'],
    hit: ['hits', 'hit', 'hitting'],
    hold: ['holds', 'held', 'holding'],
    keep: ['keeps', 'kept', 'keeping'],
    know: ['knows', 'knew', 'known', 'knowing'],
    lead: ['leads', 'led', 'leading'],
    learn: ['learns', 'learnt', 'learned', 'learning'],
    leave: ['leaves', 'left', 'leaving'],
    lend: ['lends', 'lent', 'lending'],
    let: ['lets', 'let', 'letting'],
    lie: ['lies', 'lay', 'lain', 'lying'],
    lose: ['loses', 'lost', 'losing'],
    make: ['makes', 'made', 'making'],
    mean: ['means', 'meant', 'meaning'],
    meet: ['meets', 'met', 'meeting'],
    pay: ['pays', 'paid', 'paying'],
    put: ['puts', 'put', 'putting'],
    read: ['reads', 'read', 'reading'],
    ride: ['rides', 'rode', 'ridden', 'riding'],
    rise: ['rises', 'rose', 'risen', 'rising'],
    run: ['runs', 'ran', 'running'],
    say: ['says', 'said', 'saying'],
    see: ['sees', 'saw', 'seen', 'seeing'],
    sell: ['sells', 'sold', 'selling'],
    send: ['sends', 'sent', 'sending'],
    set: ['sets', 'set', 'setting'],
    shake: ['shakes', 'shook', 'shaken', 'shaking'],
    shine: ['shines', 'shone', 'shining'],
    shoot: ['shoots', 'shot', 'shooting'],
    show: ['shows', 'showed', 'shown', 'showing'],
    shut: ['shuts', 'shut', 'shutting'],
    sing: ['sings', 'sang', 'sung', 'singing'],
    sink: ['sinks', 'sank', 'sunk', 'sinking'],
    sit: ['sits', 'sat', 'sitting'],
    sleep: ['sleeps', 'slept', 'sleeping'],
    speak: ['speaks', 'spoke', 'spoken', 'speaking'],
    spend: ['spends', 'spent', 'spending'],
    stand: ['stands', 'stood', 'standing'],
    steal: ['steals', 'stole', 'stolen', 'stealing'],
    stick: ['sticks', 'stuck', 'sticking'],
    strike: ['strikes', 'struck', 'striking'],
    swim: ['swims', 'swam', 'swum', 'swimming'],
    take: ['takes', 'took', 'taken', 'taking'],
    teach: ['teaches', 'taught', 'teaching'],
    tell: ['tells', 'told', 'telling'],
    think: ['thinks', 'thought', 'thinking'],
    throw: ['throws', 'threw', 'thrown', 'throwing'],
    understand: ['understands', 'understood', 'understanding'],
    wake: ['wakes', 'woke', 'woken', 'waking'],
    wear: ['wears', 'wore', 'worn', 'wearing'],
    win: ['wins', 'won', 'winning'],
    write: ['writes', 'wrote', 'written', 'writing'],
    wind: ['winds', 'wound', 'winding'],
    is: ['are', 'was', 'were', 'been', 'being', 'be'],
  };
  const DOUBLE = new Set(['put', 'get', 'run', 'sit', 'shut', 'cut', 'set', 'fit', 'stop', 'plan', 'drop', 'log', 'dig', 'nod', 'hug', 'bet']);
  function regularForms(base) {
    const out = [];
    const vowels = 'aeiou';
    if (/(s|x|z|ch|sh|o)$/.test(base)) out.push(base + 'es');
    else if (/[^aeiou]y$/.test(base)) out.push(base.slice(0, -1) + 'ies');
    else out.push(base + 's');
    if (/e$/.test(base)) out.push(base + 'd');
    else if (/[^aeiou]y$/.test(base)) out.push(base.slice(0, -1) + 'ied');
    else if (DOUBLE.has(base)) out.push(base + base.slice(-1) + 'ed');
    else out.push(base + 'ed');
    if (/ie$/.test(base)) out.push(base.slice(0, -2) + 'ying');
    else if (/e$/.test(base) && !/ee$/.test(base)) out.push(base.slice(0, -1) + 'ing');
    else if (DOUBLE.has(base)) out.push(base + base.slice(-1) + 'ing');
    else out.push(base + 'ing');
    return out;
  }

  const COLLOC = new Map();   // 变体 -> {phrase, meaning, kind}
  const COLLOC_KEYS = new Set();
  function buildCollocations() {
    DATA.collocations.forEach((entry) => {
      const phrase = entry[0], meaning = entry[1], kind = entry[2] || '固定搭配';
      const norm = phrase.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
      COLLOC.set(norm, { phrase, meaning, kind });
      COLLOC_KEYS.add(norm);
      const head = norm.split(' ')[0];
      const tails = norm.split(' ').slice(1).join(' ');
      if (!tails) return;
      const forms = IRR[head] || regularForms(head);
      forms.forEach((f) => {
        const k = (f + ' ' + tails).replace(/\s+/g, ' ');
        if (!COLLOC.has(k)) COLLOC.set(k, { phrase, meaning, kind });
      });
    });
  }

  /* ============================ 课标词库 ============================
   * 课程要考的词（教育部课标词汇表），来自 window.COURSE_TIERS。
   * COURSE_SET 为当前学段词表（含屈折变形）的集合，按学段缓存。 */
  let COURSE_SET = null;
  let COURSE_TIER_KEY = null;
  function ensureCourseSet() {
    const tiers = window.COURSE_TIERS || {};
    const t = tiers[state.courseTier] || tiers.primary;
    if (COURSE_TIER_KEY === state.courseTier && COURSE_SET) return;
    COURSE_TIER_KEY = state.courseTier;
    const set = new Set();
    if (!t) { COURSE_SET = set; return; }
    const words = (t.words || '').toLowerCase().split(/\s+/).filter(Boolean);
    words.forEach((w) => {
      if (!w) return;
      set.add(w);
      const forms = IRR[w] || regularForms(w);
      forms.forEach((f) => set.add(f));
    });
    COURSE_SET = set;
  }

  /* ============================ 分句 ============================ */
  const ABBR = ['Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'St', 'Jr', 'Sr', 'vs', 'etc', 'e\\.g', 'i\\.e', 'a\\.m', 'p\\.m', 'No', 'Fig', 'Inc', 'Ltd'];
  function splitSentences(text) {
    const paras = String(text).replace(/\r/g, '').split(/\n+/).map((p) => p.trim()).filter(Boolean);
    const result = [];
    paras.forEach((para, pi) => {
      let s = para;
      ABBR.forEach((a, i) => {
        s = s.replace(new RegExp('(^|\\s)(' + a + ')\\.', 'g'), '$1$2\u0001');
      });
      // 不使用 lookbehind（旧版 Safari / WebView 不支持，会整脚本崩溃），
      // 改用带捕获组的 split，把句末标点+空白并回上一句。
      const parts = s.split(/([.!?…]["'”’)\]]?\s+)/).reduce((acc, piece, i) => {
        if (i % 2 === 1) { if (acc.length) acc[acc.length - 1] += piece; else acc.push(piece); }
        else if (piece) acc.push(piece);
        return acc;
      }, []);
      parts.forEach((raw) => {
        const seg = raw.replace(/\u0001/g, '.').trim();
        if (!seg) return;
        if (!/[A-Za-z]/.test(seg)) return;      // 纯符号 / 编号行跳过
        result.push({ en: seg, para: pi });
      });
    });
    return result;
  }

  /* ============================ 标注渲染 ============================ */
  const WORD_RE = /[A-Za-z]+(?:[’'][A-Za-z]+)*/g;
  function tokens(text) {
    const out = [];
    let m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text))) {
      out.push({ w: m[0], s: m.index, e: m.index + m[0].length });
    }
    return out;
  }
  function findCollocations(tk) {
    const used = new Array(tk.length).fill(false);
    const found = [];
    for (let i = 0; i < tk.length; i++) {
      if (used[i]) continue;
      for (let n = Math.min(5, tk.length - i); n >= 2; n--) {
        const key = tk.slice(i, i + n).map((t) => t.w.toLowerCase().replace(/[’]/g, "'")).join(' ');
        const hit = COLLOC.get(key);
        if (hit) {
          found.push({ s: tk[i].s, e: tk[i + n - 1].e, key, entry: hit });
          for (let k = i; k < i + n; k++) used[k] = true;
          i += n - 1;
          break;
        }
      }
    }
    return found;
  }
  function buildSpans(text, marks, startMap) {
    let html = '';
    let i = 0;
    const sorted = marks.filter((m) => m.s >= 0 && m.e <= text.length).sort((a, b) => a.s - b.s);
    let mi = 0;
    while (i < text.length) {
      const m = sorted[mi];
      if (m && m.s === i) {
        const seg = text.slice(m.s, m.e);
        if (m.type === 'col') {
          const segMap = new Map();
          tokens(seg).forEach((t) => segMap.set(t.s, t));
          html += '<span class="col" data-c="' + attr(m.key) + '" title="' + attr(m.entry.meaning) + '">' +
            buildSpans(seg, [], segMap) + '</span>';
        } else { // cw：课标词
          html += '<span class="cw" data-w="' + attr(m.w) + '" title="课标词（课程要考的词）">' + esc(seg) + '</span>';
        }
        i = m.e; mi++;
        continue;
      }
      const t = startMap.get(i);
      if (t) {
        html += '<span class="w" data-w="' + attr(t.w) + '">' + esc(t.w) + '</span>';
        i = t.e;
        continue;
      }
      html += esc(text[i]);
      i++;
    }
    return html;
  }
  function annotate(text) {
    const tk = tokens(text);
    let cols = findCollocations(tk);
    let cwList = [];
    if (state.courseOnly) {
      ensureCourseSet();
      // 只保留「首词属于课标词」的搭配
      cols = cols.filter((c) => COURSE_SET.has(c.key.split(' ')[0]));
      // 标出落在搭配之外的课标词
      const covered = new Set();
      cols.forEach((c) => { for (let p = c.s; p < c.e; p++) covered.add(p); });
      const seen = new Set();
      tk.forEach((t) => {
        for (let p = t.s; p < t.e; p++) { if (covered.has(p)) return; }
        const w = t.w.toLowerCase().replace(/[’]/g, "'");
        if (COURSE_SET.has(w) && !seen.has(w)) {
          seen.add(w);
          cwList.push({ s: t.s, e: t.e, w: t.w });
        }
      });
    }
    const startMap = new Map();
    tk.forEach((t) => startMap.set(t.s, t));
    const marks = [];
    cols.forEach((c) => marks.push({ s: c.s, e: c.e, type: 'col', key: c.key, entry: c.entry }));
    cwList.forEach((c) => marks.push({ s: c.s, e: c.e, type: 'cw', w: c.w }));
    return {
      html: buildSpans(text, marks, startMap),
      cols: cols.map((c) => c.key),
      cwList: cwList.map((c) => c.w),
    };
  }
  function collocEntries(keys) {
    const seen = new Set();
    const out = [];
    keys.forEach((k) => {
      const e = COLLOC.get(k);
      if (!e || seen.has(e.phrase)) return;
      seen.add(e.phrase);
      out.push(e);
    });
    return out;
  }

  /* ============================ 语法规则引擎 ============================ */
  const SUBORD = [
    ['because', '原因状语从句'], ['since', '原因或时间状语从句'], ['as', '原因、时间或方式状语从句'],
    ['although', '让步状语从句'], ['though', '让步状语从句'], ['even though', '让步状语从句'],
    ['if', '条件状语从句'], ['unless', '条件状语从句'], ['when', '时间状语从句'],
    ['while', '时间或对比状语从句'], ['whenever', '时间状语从句'], ['before', '时间状语从句'],
    ['after', '时间状语从句'], ['until', '时间状语从句'], ['once', '时间状语从句'],
    ['whereas', '对比状语从句'], ['so that', '目的或结果状语从句'], ['in order that', '目的状语从句'],
    ['as if', '方式状语从句'], ['as though', '方式状语从句'], ['in case', '条件状语从句'],
  ];
  const VERB_HINT = /^(be|am|is|are|was|were|have|has|had|do|does|did|can|could|will|would|shall|should|may|might|must|go|come|take|make|get|give|put|see|look|feel|find|think|know|say|tell|want|need|like|love|hate|keep|let|leave|help|start|stop|try|use|work|play|read|write|speak|talk|walk|run|watch|listen|wait|stay|become|seem|appear|show|turn|bring|hold|set|stand|sit|begin|end|open|close|call|ask|answer|remember|forget|learn|teach|understand|notice|realize|decide|explain|explain|suggest|admit|agree|promise|hope|believe|expect|wonder|mean|matter|depend|result|lead|add|change|grow|move|live|die|pay|spend|cost|build|break|catch|cover|carry|throw|draw|push|pull|ring|sing|eat|drink|sleep|wake|wear|win|lose|fight|travel|visit|meet|join|share|solve|avoid|allow|argue|settle|respond|accept|refuse|happen|disappear|appear)$/;

  function analyzeGrammar(text) {
    const notes = [];
    const tags = [];
    const lower = text.toLowerCase();
    const words = (text.match(/[A-Za-z']+/g) || []);
    const wc = words.length;

    /* 1. 句型 */
    const coordRe = /\b(and|but|or|so|yet)\b/g;
    const coord = (lower.match(coordRe) || []).length;
    const subHits = [];
    SUBORD.forEach(([w, type]) => {
      const re = new RegExp('\\b' + w.replace(/ /g, '\\s+') + '\\b', 'i');
      if (re.test(text)) subHits.push({ w, type });
    });
    // that / which / who 引导的从句单独处理
    const relHit = /\b(which|who|whom|whose)\b|\bthat\b/.test(lower);

    let type = '简单句';
    if (subHits.length && coord >= 1) type = '并列复合句';
    else if (subHits.length >= 1 || (relHit && wc > 8)) type = '复合句';
    else if (coord >= 1) type = '并列句';
    tags.push(type);
    tags.push(wc + ' 词');

    /* 2. 时态 / 语态 */
    const tenseChecks = [
      [/\b(has|have)\s+been\s+\w+ing\b/i, '时态', '现在完成进行时：<code>have/has been + 现在分词</code>，强调动作从过去持续到现在。'],
      [/\bhad\s+been\s+\w+ing\b/i, '时态', '过去完成进行时：<code>had been + 现在分词</code>。'],
      [/\b(has|have|had)\s+(been|[a-z]+(ed|en)|gone|done|made|taken|given|seen|known|found|got|brought|kept|left|held|told|said|paid|met|sent|built|spent|lost|won|come|become|begun|written|spoken|broken|chosen|driven|eaten|fallen|forgotten|hidden|ridden|risen|stolen|torn|worn)\b/i,
        '时态', '完成时：<code>have/has/had + 过去分词</code>，注意与一般过去时的区别（是否强调对现在的影响）。'],
      [/\b(will|shall)\s+have\s+\w+/i, '时态', '将来完成时：<code>will have + 过去分词</code>。'],
      [/\b(am|is|are)\s+\w+ing\b/i, '时态', '现在进行时：<code>be + 现在分词</code>。'],
      [/\b(was|were)\s+\w+ing\b/i, '时态', '过去进行时：<code>was/were + 现在分词</code>。'],
      [/\b(am|is|are|was|were)\s+(being\s+)?[a-z]+(ed|en)\b/i, '语态', '被动语态线索：<code>be + 过去分词</code>，注意施动者是否由 by 引出。'],
      [/\b(will|shall)\s+(be\s+)?[a-z]+\b/i, '时态', '将来时：<code>will + 动词原形</code>。'],
      [/\b(must|can|could|may|might|should|would|ought to|have to|need to)\b/i, '情态', '含情态动词，表达推测、义务或能力，翻译时要还原语气（“必须／可能／应该”等）。'],
      [/\bif\b[^.]*\b(would|could|were)\b/i, '语气', '虚拟语气线索：<code>if + were/过去式 ... would + 动词原形</code>，多表示与事实相反。'],
      [/\b(more|less|fewer|better|worse|[a-z]+er)\b[^.]*\bthan\b/i, '结构', '比较结构：<code>... than ...</code>，注意比较对象要对等。'],
      [/\bnot only\b/i, '结构', '<code>not only ... but also</code> 强调结构。'],
      [/\b(there)\s+(is|are|was|were)\b/i, '结构', '<code>there be</code> 存在句，主语在 be 之后。'],
      [/\bit\s+(is|was)\s+(important|necessary|hard|difficult|easy|possible|likely|clear|true|better)\s+(to|that)\b/i, '结构', '<code>it</code> 作形式主语，真正的主语是后面的不定式或从句。'],
      [/\b(not|never|nothing|nobody|none|neither|nor)\b/i, '结构', '含否定词，注意部分否定与双重否定的译法。'],
    ];
    let tenseAdded = 0;
    tenseChecks.forEach(([re, label, txt]) => {
      const m = text.match(re);
      if (m && tenseAdded < 3) {
        notes.push({ label, text: txt + ' <i>' + esc(m[0].trim()) + '</i>' });
        if (label === '时态' || label === '语态' || label === '语气') tenseAdded++;
      }
    });

    /* 3. 从句 */
    const REPORT = /^(think|thought|thinks|say|said|says|know|knew|knows|believe|believed|believes|discover|discovered|discovers|find|found|finds|notice|noticed|realize|realized|realise|realised|feel|felt|feels|hope|hoped|expect|expected|argue|argued|claim|claimed|suggest|suggested|admit|admitted|remember|remembered|forget|forgot|forgotten|explain|explained|show|showed|shown|mean|meant|agree|agreed|doubt|doubted|observe|observed|learn|learned|learnt|hear|heard|promise|promised|decide|decided|seem|seems|seemed|appear|appears|appeared|prove|proved|worry|worried)$/;

    let clauseDone = false;
    const relM = lower.match(/\b(which|who|whom|whose)\b\s+([a-z']+)/);
    if (relM) {
      notes.push({
        label: '定语从句',
        text: '关系词 <code>' + esc(relM[1]) + '</code> 引导一个修饰成分，修饰前面的先行词；翻译时通常提到名词前作“……的”。',
      });
      clauseDone = true;
    }
    const thatMatch = lower.match(/\bthat\b/);
    if (thatMatch && thatMatch.index > 0) {
      const before = lower.slice(0, thatMatch.index).replace(/[^a-z'\s]+/g, ' ').trim();
      const wb = before.split(/\s+/).filter(Boolean).slice(-4).reverse();
      if (/^(so|such|in|now|given|but|and|except)$/.test(wb[0] || '')) {
        // so that / in that 这类，不当从句引导词分析
      } else {
        const verb = wb.find((w) => REPORT.test(w));
        const afterWord = (lower.slice(thatMatch.index + 4).trim().split(/\s+/)[0] || '').replace(/[^a-z']/g, '');
        const SUBJ = /^(i|you|he|she|it|we|they|there|this|these|those|the|a|an|my|his|her|its|our|their)$/;
        if (verb) {
          notes.push({
            label: '宾语从句',
            text: '<code>' + esc(verb) + ' … that …</code>：that 从句作 <code>' + esc(verb) + '</code> 的宾语，是“说／想／发现一件事”的典型结构，从句用陈述语序。',
          });
        } else if (afterWord && SUBJ.test(afterWord)) {
          notes.push({
            label: '从句判断',
            text: '<code>that</code> 后面已经有主语 <code>' + esc(afterWord) + '</code>，that 在从句里不作主语；前面是 <code>' + esc(wb[0]) + '</code>，大概率是同位语从句，或 that 作宾语的定语从句。',
          });
        } else if (/^[a-z]{2,}(s|ed|es|ing)$/.test(afterWord)) {
          notes.push({
            label: '定语从句',
            text: '<code>that</code> 后面直接接动词 <code>' + esc(afterWord) + '</code>，说明 that 在从句中充当主语，整个从句修饰前面的 <code>' + esc(wb[0] || '名词') + '</code>。',
          });
        } else if (wb.length) {
          notes.push({
            label: '从句判断',
            text: '<code>that</code> 前面是 <code>' + esc(wb[0]) + '</code>：可能是定语从句（修饰它），也可能是同位语从句（说明它的内容）——看从句里是否缺主语或宾语。',
          });
        }
        clauseDone = true;
      }
    }
    if (!clauseDone) {
      const objM = lower.match(/\b(think|know|say|believe|hope|find|notice|wonder|ask|decide|realize|explain|suggest|expect)\s+(if|whether|what|how|why|when|who)\b/);
      if (objM) {
        notes.push({ label: '宾语从句', text: '<code>' + esc(objM[0]) + '</code>：谓语后接 wh- 从句作宾语，注意从句也要用陈述语序。' });
      }
    }
    subHits.slice(0, 2).forEach((h) => {
      notes.push({ label: '状语从句', text: '引导词 <code>' + h.w + '</code> → 可能是' + h.type + '，先抓主句，再挂从句。' });
    });

    /* 4. 非谓语 */
    const infM = text.match(/\bto\s+([a-z]+)\b/i);
    if (infM && !/^(the|a|an|his|her|my|your|our|their|this|that|these|those|it|him|them|me|us|you|be)$/i.test(infM[1])) {
      notes.push({ label: '非谓语', text: '出现 <code>' + esc(infM[0]) + '</code>：to 后接动词原形，是不定式，常作目的状语或后置定语。' });
    }
    const ingM = text.match(/\b([a-z]{4,}ing)\b/i);
    if (ingM && !/\b(am|is|are|was|were|been)\s+[a-z]+ing\b/i.test(text)) {
      notes.push({ label: '非谓语', text: '<code>' + esc(ingM[1]) + '</code> 前没有 be，可能是动名词（作主语或宾语）或现在分词（作定语、状语）。' });
    }

    /* 5. 祈使句 */
    const first = (words[0] || '').toLowerCase();
    if (VERB_HINT.test(first) && !/^(i|we|you|he|she|it|they|there|this|that|these|those)$/i.test(first)) {
      tags.push('可能是祈使句');
    }
    if (/\?\s*$/.test(text)) tags.push('疑问句');
    if (wc > 30) tags.push('长句');

    return { tags, notes: notes.slice(0, 6) };
  }

  /* ============================ 翻译服务 ============================ */
  let trChain = Promise.resolve();
  // 简单串行队列：优先任务（用户当前点的句子、单词）插队，避免免费接口被瞬时并发打挂
  const trQueue = [];
  let trRunning = false;
  function enqueue(fn, priority) {
    return new Promise((resolve, reject) => {
      if (priority) trQueue.unshift({ fn, resolve, reject });
      else trQueue.push({ fn, resolve, reject });
      pump();
    });
  }
  async function pump() {
    if (trRunning) return;
    trRunning = true;
    while (trQueue.length) {
      const job = trQueue.shift();
      try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
      await sleep(240);
    }
    trRunning = false;
  }
  function serial(fn) { return enqueue(fn, false); }

  async function mmTranslate(text) {
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en|zh-CN';
    let j;
    try {
      j = await fetchJSON(url, null, 6000);
    } catch (e) {
      if (e.name === 'AbortError') { markNetFail('翻译接口超时（网络较慢或被拦截）。翻译/查词需要联网；或在“设置”里填自定义 AI（如 DeepSeek）后离线可用。'); throw new Error('翻译接口超时'); }
      if (e.status === 429 || e.status === 403) throw new Error('免费翻译额度用完了（次日恢复），或到“设置”改用自定义 AI 接口');
      markNetFail('翻译接口连不上（' + (e.message || '网络问题') + '）。翻译/查词需要联网；或在“设置”里填自定义 AI（如 DeepSeek）。');
      throw new Error('翻译接口连不上（' + (e.message || '网络问题') + '）');
    }
    const t = j && j.responseData && j.responseData.translatedText;
    if (!t) throw new Error('翻译结果为空');
    if (/QUOTA/i.test(t)) throw new Error('免费翻译额度用完了（次日恢复），或到“设置”改用自定义 AI 接口');
    if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE PAIR/i.test(t)) throw new Error(t);
    return decodeEntities(t);
  }

  async function aiChat(messages) {
    const { base, model, key } = state.ai;
    if (!key) throw new Error('还没填 API Key');
    const url = String(base || '').replace(/\/+$/, '') + '/chat/completions';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: model || 'gpt-4o-mini', messages, temperature: 0.2 }),
      signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 30000); return c.signal; })(),
    });
    if (!r.ok) throw new Error('AI 接口返回 ' + r.status + (r.status === 401 ? '（Key 无效）' : ''));
    const j = await r.json();
    return (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }
  function parseJSONish(s) {
    if (!s) return null;
    let t = s.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b < 0) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
  }

  async function aiAnalyzeSentence(text) {
    const content = await aiChat([
      { role: 'system', content: '你是英语精读老师，只输出 JSON，不要任何多余解释。' },
      {
        role: 'user',
        content: '分析下面这句英文，输出 JSON：\n' +
          '{"translation":"准确自然的中文翻译，不要逐词硬译",' +
          '"grammar":[{"label":"结构点名称，如 时态/从句/非谓语/语态","detail":"一句话说明，可引用原句关键词"}],' +
          '"collocations":[{"phrase":"原句中的固定搭配原文","meaning":"中文含义"}]}\n' +
          '要求：grammar 给 3-5 条，聚焦句子结构、时态语态、从句、非谓语、易错点；collocations 只列真正固定的搭配（短语动词、习语、介词搭配），没有就返回空数组。\n句子：' + text,
      },
    ]);
    const j = parseJSONish(content);
    if (!j) throw new Error('AI 返回内容无法解析');
    return {
      translation: String(j.translation || '').trim(),
      grammar: Array.isArray(j.grammar) ? j.grammar.filter((g) => g && g.label).slice(0, 6) : [],
      collocations: Array.isArray(j.collocations) ? j.collocations.filter((c) => c && c.phrase) : [],
    };
  }

  const inflight = new Map();
  async function translateAll(text, priority) {
    if (state.tcache[text]) return { text: state.tcache[text], source: 'cache' };
    if (inflight.has(text)) return inflight.get(text);
    // 联网已确认连不上时，直接快退，避免每个句子都干等 6 秒
    if (NET_FAIL && !(state.provider === 'ai' && state.ai.key)) {
      throw new Error('翻译服务连不上（需要联网，或在设置里填自定义 AI）');
    }
    const task = (async () => {
      if (state.provider === 'ai' && state.ai.key) {
        try {
          const r = await aiAnalyzeSentence(text);
          state.tcache[text] = r.translation;
          return { text: r.translation, source: 'ai', grammar: r.grammar, collocations: r.collocations };
        } catch (e) {
          const t = await enqueue(() => mmTranslate(text), priority);
          state.tcache[text] = t;
          return { text: t, source: 'mymemory-fallback', warn: e.message };
        }
      }
      const t = await enqueue(() => mmTranslate(text), priority);
      state.tcache[text] = t;
      return { text: t, source: 'mymemory' };
    })();
    inflight.set(text, task);
    try { return await task; } finally { inflight.delete(text); }
  }

  /* ============================ 朗读 ============================ */
  const synth = window.speechSynthesis;
  let voices = [];

  function loadVoices() {
    if (!synth) return;
    const all = synth.getVoices() || [];
    voices = all.filter((v) => /^en([-_]|$)/i.test(v.lang));
    if (!voices.length) voices = all;           // 退而求其次用全部音色
    // 有音色但一个英文的都没有 → 朗读多半会无声
    state.noEnglish = !!all.length && !all.some((v) => /^en([-_]|$)/i.test(v.lang));
    const hint = document.getElementById('voice-hint');
    if (hint) hint.style.display = state.noEnglish ? '' : 'none';
    if (state.noEnglish && !window.__voiceWarned) {
      window.__voiceWarned = true;
      toast('未检测到英文语音包，朗读可能无声。请到系统设置安装英文语音，或换 Chrome / Edge 打开');
    }
    const sel = $('#voice');
    const prev = state.voiceURI;
    sel.innerHTML = '';
    if (!voices.length) {
      sel.innerHTML = '<option value="">未找到音色（朗读可能无声）</option>';
      return;
    }
    voices.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = v.name.replace(/Microsoft |Google /g, '') + ' · ' + v.lang;
      sel.appendChild(o);
    });
    let pick = voices.find((v) => v.voiceURI === prev);
    if (!pick) pick = voices.find((v) => /en|google|natural|online/i.test(v.name)) || voices[0];
    state.voiceURI = pick.voiceURI;
    sel.value = pick.voiceURI;
  }
  function currentVoice() {
    return voices.find((v) => v.voiceURI === state.voiceURI) || voices[0] || null;
  }

  function stopSpeaking() {
    state.playing = false;
    state.speakSeq++;
    if (synth) synth.cancel();
    updatePlayBtn();
  }
  function updatePlayBtn() {
    $('#play-icon').textContent = state.playing ? '❚❚' : '▶';
  }

  // 等语音列表就绪：首次点击时音色可能还没加载完，Chrome 会哑火
  function waitForVoices(ms) {
    if (voices.length || !synth) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; try { synth.removeEventListener('voiceschanged', finish); } catch (e) {} resolve(); };
      try { synth.addEventListener('voiceschanged', finish); } catch (e) {}
      setTimeout(finish, ms || 1500);
    });
  }

  async function speak(index, opts) {
    opts = opts || {};
    if (!synth) { toast('当前浏览器不支持语音朗读，换个浏览器试试'); return; }
    const s = state.sentences[index];
    if (!s) return;
    // 首句前若语音列表还没加载完，等一下再念，避免 Chrome 首句哑火
    if (!voices.length) { await waitForVoices(1500); loadVoices(); }
    const v = currentVoice();
    if (!v && state.noEnglish) {
      toast('未检测到英文语音包，无法朗读。请到系统设置安装英文语音，或换 Chrome / Edge 打开');
    }
    const seq = ++state.speakSeq;
    synth.cancel();
    if (synth.paused) synth.resume();
    selectSentence(index, { scroll: true, silent: opts.silent });
    const u = new SpeechSynthesisUtterance(s.en);
    const vv = currentVoice();
    if (vv) { u.voice = vv; u.lang = vv.lang; } else { u.lang = 'en-US'; }
    u.rate = state.rate;
    u.pitch = 1;

    let finished = false;
    const next = () => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      if (seq !== state.speakSeq) return;          // 已被打断
      if (!state.playing) return;
      if (index + 1 < state.sentences.length) speak(index + 1);
      else { state.playing = false; updatePlayBtn(); }
    };
    u.onend = next;
    u.onerror = (e) => {
      if (e && (e.error === 'interrupted' || e.error === 'canceled')) { clearTimeout(watchdog); finished = true; return; }
      next();
    };

    // 看门狗：某些环境（无音频设备、语音引擎挂住）不会触发 onend，
    // 按句长估个上限，超时就自动跳到下一句，避免整个朗读卡死。
    const words = s.en.split(/\s+/).filter(Boolean).length;
    const est = Math.max(4000, (words / (2.3 * state.rate)) * 1000 * 2.1) + 1500;
    const watchdog = setTimeout(next, est);

    synth.speak(u);
  }

  function speakWord(word) {
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(word);
    const v = currentVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
    u.rate = 0.85;
    synth.speak(u);
  }

  function startPlay() {
    if (!state.sentences.length) return;
    state.playing = true;
    updatePlayBtn();
    const from = state.current < 0 ? 0 : state.current;
    speak(from);
  }
  function togglePlay() {
    if (state.playing) { stopSpeaking(); return; }
    startPlay();
  }

  /* ============================ 渲染阅读区 ============================ */
  function renderReader() {
    const reader = $('#reader');
    reader.innerHTML = '';
    let lastPara = -1;
    let paraEl = null;
    let cwTotal = 0;
    state.sentences.forEach((s, i) => {
      if (s.para !== lastPara) {
        paraEl = document.createElement('div');
        paraEl.className = 'para';
        reader.appendChild(paraEl);
        lastPara = s.para;
      }
      const a = annotate(s.en);
      cwTotal += a.cwList.length;
      const el = document.createElement('div');
      el.className = 'sent';
      el.dataset.i = String(i);
      el.innerHTML =
        '<p class="en">' + a.html + '</p>' +
        '<p class="zh" data-i="' + i + '"></p>' +
        '<button class="sent-play" data-play="' + i + '" title="朗读这句">▶</button>';
      paraEl.appendChild(el);
    });
    // 固定搭配逐个挂上（用于点选）
    $$('.sent').forEach((el) => {
      el.addEventListener('click', (ev) => {
        const w = ev.target.closest('.w, .cw');
        const col = ev.target.closest('.col');
        const i = Number(el.dataset.i);
        if (w) {
          selectSentence(i, { scroll: false });
          openWordCard(w.dataset.w, w);
          return;
        }
        if (col) {
          selectSentence(i, { scroll: false, focusColloc: col.dataset.c });
          return;
        }
        selectSentence(i, { scroll: false });
      });
    });
    $$('.sent-play').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.playing = false;
        speak(Number(b.dataset.play));
      });
    });
    $('#progress-label').textContent = '0 / ' + state.sentences.length;
    const wordN = (state.sentences.map((s) => s.en).join(' ').match(/[A-Za-z']+/g) || []).length;
    $('#article-meta').textContent = state.sentences.length + ' 句 · ' + wordN + ' 词' +
      (state.courseOnly ? ' · ' + cwTotal + ' 课标词' : '');
    document.title = (state.title || '精读台') + ' · 精读台';
    $('#article-title').value = state.title || '';
    reader.classList.toggle('dictation-on', state.dictation);
    reader.classList.toggle('cw-on', state.courseOnly);
    if (state.dictation) attachDictation();
  }

  /* ============================ 听写模式 ============================ */
  function normalizeWords(t) {
    return (t || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  }
  function attachDictation() {
    $$('.sent').forEach((el) => {
      const i = Number(el.dataset.i);
      if ($('.dict-box', el)) return;
      const box = document.createElement('div');
      box.className = 'dict-box';
      box.innerHTML =
        '<textarea class="dict-input" rows="2" placeholder="听一句，写一句…"></textarea>' +
        '<div class="dict-actions">' +
          '<button class="dict-submit btn">提交对照</button>' +
          '<button class="dict-listen btn ghost">再听一次</button>' +
        '</div>' +
        '<div class="dict-result"></div>';
      el.appendChild(box);
      $('.dict-submit', box).addEventListener('click', () => dictCheck(i));
      $('.dict-listen', box).addEventListener('click', (ev) => { ev.stopPropagation(); speak(i, { silent: true }); });
      box.addEventListener('click', (ev) => ev.stopPropagation());
    });
  }
  function startDictation(i) {
    if (!state.sentences.length) return;
    state.dictation = true;
    if (i == null) i = state.current < 0 ? 0 : state.current;
    selectSentence(i, { scroll: true });
    speak(i, { silent: true });
    const box = $('.sent[data-i="' + i + '"] .dict-box');
    if (box) { const ta = $('.dict-input', box); if (ta) ta.focus(); }
  }
  function dictCheck(i) {
    const s = state.sentences[i];
    if (!s) return;
    const box = $('.sent[data-i="' + i + '"] .dict-box');
    if (!box) return;
    const input = $('.dict-input', box).value;
    const target = normalizeWords(s.en);
    const got = normalizeWords(input);
    let html = '', correct = 0;
    const total = target.length;
    const maxLen = Math.max(target.length, got.length);
    for (let k = 0; k < maxLen; k++) {
      const t = target[k], g = got[k];
      if (t && g && t === g) { html += '<span class="d-ok">' + esc(g) + '</span> '; correct++; }
      else if (t && !g) { html += '<span class="d-miss">' + esc(t) + '</span> '; }
      else if (!t && g) { html += '<span class="d-extra">' + esc(g) + '</span> '; }
      else { html += '<span class="d-wrong">' + esc(g) + '</span> '; }
    }
    const score = total ? Math.round((correct / total) * 100) : 0;
    box.querySelector('.dict-result').innerHTML =
      '<p class="d-score">正确率 ' + score + '%（' + correct + '/' + total + '）</p>' +
      '<p class="d-detail">' + html + '</p>' +
      '<p class="d-answer"><b>原文：</b>' + esc(s.en) + '</p>';
  }

  /* ============================ 句子选择 & 面板 ============================ */
  function selectSentence(i, opts) {
    opts = opts || {};
    const s = state.sentences[i];
    if (!s) return;
    state.current = i;
    $$('.sent').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === i));
    const el = $('.sent[data-i="' + i + '"]');
    if (el && opts.scroll) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (el && state.bilingual) ensureSentenceTranslation(i);
    $('#progress-label').textContent = (i + 1) + ' / ' + state.sentences.length;
    renderPanel(i, opts);
  }

  function renderPanel(i, opts) {
    opts = opts || {};
    const s = state.sentences[i];
    const g = analyzeGrammar(s.en);
    const a = annotate(s.en);
    const cols = collocEntries(a.cols);
    const cached = state.analysis[i] || {};

    const collocHTML = cols.length
      ? cols.map((c) =>
        '<div class="colloc-item" data-phrase="' + attr(c.phrase) + '">' +
        '<span class="ph">' + esc(c.phrase) + '</span>' +
        '<span class="mn">' + esc(c.meaning) + '</span></div>').join('')
      : '<div class="colloc-empty">这句没有命中固定搭配库里的短语。</div>';

    const grammarNotes = (cached.grammar && cached.grammar.length)
      ? cached.grammar.map((x) => '<li><span class="lk">' + esc(x.label) + '</span>' + esc(x.detail) + '</li>').join('')
      : g.notes.map((x) => '<li><span class="lk">' + esc(x.label) + '</span>' + x.text + '</li>').join('');

    const tagsHTML = g.tags.map((t, idx) => '<span class="tag' + (idx ? ' alt' : '') + '">' + esc(t) + '</span>').join('');

    const cw = a.cwList || [];
    const cwHTML = (state.courseOnly && cw.length)
      ? '<div class="p-cw"><span class="cw-label">本课标词 · ' + cw.length + '</span>' +
        cw.map((w) => '<button class="cw-chip" data-w="' + attr(w) + '">' + esc(w) + '</button>').join('') + '</div>'
      : '';

    $('#panel-inner').innerHTML =
      '<div class="p-sec">' +
        '<h3>原句</h3>' +
        '<p class="p-original">' + a.html + '</p>' +
        cwHTML +
      '</div>' +
      '<div class="p-sec">' +
        '<h3>中文翻译</h3>' +
        '<p class="p-trans" id="p-trans">' + (cached.translation ? esc(cached.translation) : '翻译中…') + '</p>' +
        '<div class="sec-actions"><button class="link-btn" id="btn-retranslate">重新翻译</button>' +
        '<button class="link-btn" id="btn-read-sentence">朗读这句</button></div>' +
      '</div>' +
      '<div class="p-sec">' +
        '<h3>语法结构</h3>' +
        '<div class="tag-row">' + tagsHTML + '</div>' +
        '<ul class="note-list">' + (grammarNotes || '<li>未识别到明显的结构特征。</li>') + '</ul>' +
        (cached.grammar && cached.grammar.length ? '' : '<p class="disclaimer">结构分析由本地规则引擎给出（按助动词、引导词、词形匹配），不是完整句法树；判断以阅读理解为目的，个别长句可能不全。</p>') +
      '</div>' +
      '<div class="p-sec">' +
        '<h3>固定搭配 · ' + cols.length + '</h3>' +
        collocHTML +
        '<p class="disclaimer">库内 ' + COLLOC_KEYS.size + ' 条搭配（短语动词 / 介词搭配 / 习语）。点“朗读这句”可以听整句连读。</p>' +
      '</div>';

    // 面板内交互
    const btnR = $('#btn-retranslate');
    if (btnR) btnR.addEventListener('click', () => {
      delete state.analysis[i];
      delete state.tcache[s.en];
      NET_FAIL = false; netBannerOpen = false;
      const b = document.getElementById('status-banner'); if (b) b.classList.add('hidden');
      fetchSentenceTranslation(i, true);
    });
    const btnRead = $('#btn-read-sentence');
    if (btnRead) btnRead.addEventListener('click', () => { state.playing = false; speak(i); });
    $$('.colloc-item', $('#panel-inner')).forEach((el) => {
      el.addEventListener('click', () => speakWord(el.dataset.phrase));
    });
    $$('.cw-chip', $('#panel-inner')).forEach((el) => {
      el.addEventListener('click', () => openWordCard(el.dataset.w, el));
    });
    $$('.p-original .w, .p-original .cw', $('#panel-inner')).forEach((w) => {
      w.addEventListener('click', () => openWordCard(w.dataset.w, w));
    });
    if (opts.focusColloc) {
      const target = $$('.colloc-item', $('#panel-inner')).find((el) =>
        el.dataset.phrase.toLowerCase() === opts.focusColloc.toLowerCase());
      if (target) target.scrollIntoView({ block: 'nearest' });
    }

    if (!cached.translation) fetchSentenceTranslation(i, false);
  }

  async function fetchSentenceTranslation(i, force) {
    const s = state.sentences[i];
    if (!s) return;
    const box = $('#p-trans');
    if (box) { box.textContent = '翻译中…'; box.className = 'p-trans loading'; }
    try {
      const r = await translateAll(s.en, true);
      if (state.current !== i) return;
      state.analysis[i] = {
        translation: r.text,
        grammar: r.grammar || null,
        collocations: r.collocations || null,
      };
      const t = $('#p-trans');
      if (t) { t.textContent = r.text; t.className = 'p-trans'; }
      if (r.grammar && r.grammar.length) {
        // AI 给出了更细的语法点，重绘一次
        renderPanel(i, { silent: true });
      }
      paintSentenceTranslation(i, r.text);
    } catch (e) {
      const t = $('#p-trans');
      if (t) {
        t.textContent = '翻译失败：' + e.message + '。可以到“设置”里改用自定义 AI 接口。';
        t.className = 'p-trans error';
      }
    }
  }

  function paintSentenceTranslation(i, text) {
    const zh = $('.zh[data-i="' + i + '"]');
    if (!zh) return;
    zh.textContent = text;
    zh.className = 'zh';
  }

  async function ensureSentenceTranslation(i) {
    if (!state.bilingual) return;
    const s = state.sentences[i];
    if (!s) return;
    const zh = $('.zh[data-i="' + i + '"]');
    if (!zh || zh.dataset.done === '1') return;
    zh.dataset.done = '1';
    if (state.tcache[s.en]) { paintSentenceTranslation(i, state.tcache[s.en]); return; }
    zh.textContent = '…';
    zh.className = 'zh loading';
    try {
      const r = await translateAll(s.en, i === state.current);
      paintSentenceTranslation(i, r.text);
    } catch (e) {
      if (zh) { zh.textContent = '（翻译失败，可点击句子在右侧重试）'; zh.className = 'zh error'; }
      zh.dataset.done = '0';
    }
  }

  function backfillTranslations() {
    if (!state.bilingual) return;
    // 串行排队，避免免费接口被限流
    state.sentences.forEach((s, i) => { ensureSentenceTranslation(i); });
  }

  /* ============================ 单词卡 ============================ */
  const IRREG_PAST = /^(went|came|took|made|got|gave|put|saw|found|thought|said|told|knew|kept|left|felt|brought|held|built|sent|paid|met|lost|won|began|became|understood|spoke|wrote|read|ran|sat|stood|took|grew|drew|threw|caught|taught|bought|fought|sought|woke|wore|broke|chose|drove|ate|fell|forgot|hid|rode|rose|sang|swam)$/;

  function lemmaCandidates(w) {
    const out = [w];
    const add = (x) => { if (x && x.length > 2 && out.indexOf(x) < 0) out.push(x); };
    if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ves$/.test(w)) add(w.slice(0, -3) + 'f');
    if (/(ses|xes|zes|ches|shes|oes)$/.test(w)) add(w.slice(0, -2));
    if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
    if (/ied$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ed$/.test(w)) { add(w.slice(0, -1)); add(w.slice(0, -2)); if (/(.)\1ed$/.test(w)) add(w.slice(0, -3)); }
    if (/ing$/.test(w)) {
      add(w.slice(0, -3));
      add(w.slice(0, -3) + 'e');
      if (/(.)\1ing$/.test(w)) add(w.slice(0, -4));
      if (/ying$/.test(w)) add(w.slice(0, -4) + 'ie');
    }
    if (/est$/.test(w)) { add(w.slice(0, -3)); add(w.slice(0, -2)); }
    if (/er$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
    if (/ly$/.test(w)) add(w.slice(0, -2));
    return out;
  }

  async function fetchDatamuse(w) {
    try {
      const j = await fetchJSON('https://api.datamuse.com/words?sp=' + encodeURIComponent(w) + '&md=d&max=1', null, 4000);
      const e = Array.isArray(j) ? j[0] : null;
      if (!e || !e.defs) return null;
      const defs = e.defs.slice(0, 2).map((d) => {
        const parts = String(d).split('\t');
        return { pos: parts[0] || '', def: parts[1] || parts[0], ex: '' };
      });
      return { word: e.word || w, ipa: '', audio: '', defs, lemma: '' };
    } catch (e) { return null; }
  }

  const POS_ORDER = { noun: 0, verb: 1, adjective: 2, adverb: 3, pronoun: 4, preposition: 5, conjunction: 6 };

  // 词典源 1：freedictionaryapi.com（Wiktionary 衍生，音标齐全）
  async function fetchFreeDict(w) {
    const j = await fetchJSON('https://freedictionaryapi.com/api/v1/entries/en/' + encodeURIComponent(w), null, 5000);
    const entries = (j && j.entries) || [];
    if (!entries.length) return null;
    const sorted = entries.slice().sort((a, b) =>
      (POS_ORDER[a.partOfSpeech] == null ? 9 : POS_ORDER[a.partOfSpeech]) -
      (POS_ORDER[b.partOfSpeech] == null ? 9 : POS_ORDER[b.partOfSpeech]));
    let ipa = '';
    for (const e of sorted) {
      const p = (e.pronunciations || []).find((x) => x.type === 'ipa' && /^\//.test(x.text || ''));
      if (p) { ipa = p.text; break; }
    }
    const defs = [];
    for (const e of sorted) {
      const senses = e.senses || [];
      const good = senses.find((s) => !(s.tags || []).some((t) => /archaic|obsolete|dated/i.test(t))) || senses[0];
      if (good && good.definition) {
        defs.push({ pos: e.partOfSpeech || '', def: good.definition, ex: (good.examples || [])[0] || '' });
      }
      if (defs.length >= 2) break;
    }
    return { word: j.word || w, ipa, audio: '', defs, lemma: '' };
  }

  // 词典源 2：dictionaryapi.dev
  async function fetchDictApi(w) {
    const j = await fetchJSON('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w), null, 5000);
    const e = Array.isArray(j) ? j[0] : null;
    if (!e) return null;
    const ipa = e.phonetic || ((e.phonetics || []).map((p) => p.text).find(Boolean)) || '';
    const audio = ((e.phonetics || []).map((p) => p.audio).find(Boolean)) || '';
    const defs = [];
    (e.meanings || []).slice(0, 2).forEach((m) => {
      const d = m.definitions && m.definitions[0];
      if (d) defs.push({ pos: m.partOfSpeech, def: d.definition, ex: d.example || '' });
    });
    return { word: e.word || w, ipa, audio, defs, lemma: '' };
  }

  async function fetchDict(w) {
    for (const cand of lemmaCandidates(w).slice(0, 3)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const d = await fetchFreeDict(cand);
          if (d && (d.ipa || (d.defs && d.defs.length))) {
            if (cand !== w) d.lemma = cand;
            else if (d.word && d.word.toLowerCase() !== w) d.lemma = d.word;
            return d;
          }
          break;
        } catch (err) {
          if (err.status === 404) break;
          await sleep(200 * (attempt + 1));
        }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const d = await fetchDictApi(cand);
          if (d && (d.ipa || (d.defs && d.defs.length))) {
            if (cand !== w) d.lemma = cand;
            return d;
          }
          break;
        } catch (err) {
          if (err.status === 404) break;
          await sleep(200 * (attempt + 1));
        }
      }
    }
    // 兵底：Datamuse（WordNet 释义，没有音标）
    for (const cand of lemmaCandidates(w).slice(0, 2)) {
      const dm = await fetchDatamuse(cand);
      if (dm) return dm;
    }
    return null;
  }

  function positionCard(card, anchor) {
    const rect = anchor.getBoundingClientRect();
    const w = card.offsetWidth || 320;
    const h = card.offsetHeight || 200;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(12, Math.min(left, vw - w - 12));
    let top = rect.bottom + 10;
    if (top + h > vh - 16) top = Math.max(12, rect.top - h - 10);
    if (vw <= 940) { card.style.left = ''; card.style.top = ''; return; }
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  const FUNC_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'and', 'or', 'but', 'if', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'have', 'has', 'had', 'it', 'its', 'he', 'she', 'they', 'we', 'you', 'i', 'his', 'her', 'their', 'our', 'my', 'your', 'them', 'him', 'us', 'this', 'that', 'these', 'those', 'not', 'than']);

  function trimCache() {
    const keys = Object.keys(state.wordCache);
    if (keys.length > 300) keys.slice(0, keys.length - 300).forEach((k) => delete state.wordCache[k]);
  }

  async function openWordCard(raw, anchor) {
    const card = $('#wordcard');
    const word = raw.toLowerCase().replace(/[’]/g, "'");
    state.cardWord = word;
    const cached = state.wordCache[word];
    const isFunc = FUNC_WORDS.has(word);
    card.classList.remove('hidden');
    card.innerHTML = wcShell(word, cached || { word, pending: true, func: isFunc });
    positionCard(card, anchor);
    bindCardEvents(word);
    if (cached) return;

    const entry = { word, ipa: '', audio: '', defs: [], zh: '', zhDef: '', func: isFunc, lemma: '', pending: true };
    const paint = () => {
      if (state.cardWord !== word) return;
      card.innerHTML = wcShell(word, entry);
      bindCardEvents(word);
      positionCard(card, anchor);
    };

    const dictP = fetchDict(word).then((d) => {
      if (!d) return;
      entry.ipa = d.ipa;
      entry.audio = d.audio;
      entry.defs = d.defs;
      entry.lemma = d.lemma;
      entry.pending = false;
      paint();
    }).catch(() => {});

    const zhP = isFunc
      ? Promise.resolve()
      : enqueue(() => mmTranslate(word), true).then((t) => { entry.zh = t; paint(); }).catch(() => {});

    // 先等词典回来，再把英文释义翻成中文（整句翻译比单翻一个词靠谱得多）
    await dictP;
    if (entry.defs[0] && !isFunc) {
      const rawDef = String(entry.defs[0].def).split(/[(（;]/)[0].trim().slice(0, 160);
      if (rawDef) {
        try { entry.zhDef = await enqueue(() => mmTranslate(rawDef), true); } catch (e) { /* 翻不出来就不显示 */ }
        paint();
      }
    }
    await zhP;
    entry.pending = false;
    paint();

    if (entry.ipa || (entry.defs && entry.defs.length) || entry.zh) {
      state.wordCache[word] = entry;
      trimCache();
      LS.set('wordCache3', state.wordCache);
    }
  }

  function cleanGloss(t) {
    if (!t) return '';
    const s = String(t).trim();
    if (!s || s.length > 14) return '';
    if (/[。，；！？、]/.test(s)) return '';
    return s;
  }

  function wcShell(word, e) {
    if (!e) {
      return '<button class="icon-btn wc-close" data-wc-close>✕</button>' +
        '<div class="wc-head"><h3 class="wc-word">' + esc(word) + '</h3></div>' +
        '<p class="wc-zh loading">查词中…</p>';
    }
    const loading = !!e.pending;
    let ipaHTML;
    if (e.ipa) {
      ipaHTML = '<span class="wc-ipa">' + esc(e.ipa.indexOf('/') === 0 ? e.ipa : '/' + e.ipa + '/') + '</span>';
    } else if (loading) {
      ipaHTML = '<span class="wc-ipa" style="color:var(--ink-dim)">音标查询中…</span>';
    } else {
      ipaHTML = '<span class="wc-ipa" style="color:var(--ink-dim)">音标暂缺</span>';
    }
    ipaHTML += '<button class="link-btn" data-wc-say>听读音</button>';
    const lemmaNote = e.lemma ? '<p class="wc-def"><em>原形</em>' + esc(e.lemma) + '</p>' : '';
    // 单词直译只作为一个短标注用，句子式的乱翻译直接丢掉
    const gloss = cleanGloss(e.zh);
    let zhHTML = '';
    if (e.func) {
      zhHTML = '<p class="wc-zh" style="font-size:13.5px;color:var(--ink-dim)">功能词（冠词、介词、代词等），本身没有独立词义，要放到句子里看它在替什么、引什么。</p>';
    } else if (gloss || e.zhDef) {
      if (gloss) zhHTML += '<p class="wc-zh">' + esc(gloss) + '</p>';
      if (e.zhDef) {
        zhHTML += gloss
          ? '<p class="wc-def"><em>释义</em>' + esc(e.zhDef) + '</p>'
          : '<p class="wc-zh">' + esc(e.zhDef) + '</p>';
      }
    } else if (loading) {
      zhHTML = '<p class="wc-zh loading">查词中…</p>';
    } else {
      zhHTML = '<p class="wc-zh loading">中文释义没取到，可以先听发音。</p>';
    }
    const defHTML = (e.defs || []).map((d) =>
      '<p class="wc-def"><em>' + esc(d.pos) + '</em>' + esc(d.def) + '</p>' +
      (d.ex ? '<p class="wc-ex">' + esc(d.ex) + '</p>' : '')).join('');
    const nothing = !e.ipa && !(e.defs && e.defs.length);
    const failHTML = (!loading && nothing)
      ? '<p class="wc-def" style="color:var(--danger)">词典接口这次没读到（需要联网，或接口限流）。<button class="link-btn" data-wc-retry>重试</button></p>'
      : '';
    const inBook = state.words.some((x) => x.w === word);
    return '<button class="icon-btn wc-close" data-wc-close>✕</button>' +
      '<div class="wc-head"><h3 class="wc-word">' + esc(word) + '</h3>' + ipaHTML + '</div>' +
      zhHTML + lemmaNote + (defHTML || '') + failHTML +
      '<div class="wc-actions">' +
        '<button class="btn" data-wc-say>🔊 朗读单词</button>' +
        (e.audio ? '<button class="btn" data-wc-audio>真人音频</button>' : '') +
        '<button class="btn ' + (inBook ? 'ghost' : 'primary') + '" data-wc-add>' + (inBook ? '已在生词本' : '＋ 生词本') + '</button>' +
      '</div>';
  }

  function bindCardEvents(word) {
    const card = $('#wordcard');
    $$('[data-wc-close]', card).forEach((b) => b.addEventListener('click', closeCard));
    const say = $('[data-wc-say]', card);
    if (say) say.addEventListener('click', () => speakWord(word));
    const aud = $('[data-wc-audio]', card);
    if (aud) aud.addEventListener('click', () => {
      const e = state.wordCache[word];
      if (e && e.audio) { const a = new Audio(e.audio); a.play().catch(() => toast('音频播放失败')); }
    });
    const add = $('[data-wc-add]', card);
    if (add) add.addEventListener('click', () => toggleWord(word));
    const retry = $('[data-wc-retry]', card);
    if (retry) retry.addEventListener('click', () => {
      delete state.wordCache[word];
      LS.set('wordCache3', state.wordCache);
      NET_FAIL = false; netBannerOpen = false;
      const b = document.getElementById('status-banner'); if (b) b.classList.add('hidden');
      const el = $('.w[data-w="' + word + '"]');
      openWordCard(word, el || card);
    });
  }

  function closeCard() {
    $('#wordcard').classList.add('hidden');
    state.cardWord = null;
  }

  function toggleWord(word) {
    const idx = state.words.findIndex((x) => x.w === word);
    if (idx >= 0) {
      state.words.splice(idx, 1);
      toast('已从生词本移除');
    } else {
      const e = state.wordCache[word] || {};
      state.words.unshift({ w: word, ipa: e.ipa || '', zh: cleanGloss(e.zh) || e.zhDef || '', at: Date.now() });
      toast('已加入生词本');
    }
    LS.set('words', state.words);
    updateWordCount();
    if (state.cardWord === word) {
      const card = $('#wordcard');
      card.innerHTML = wcShell(word, state.wordCache[word]);
      bindCardEvents(word);
    }
  }
  function updateWordCount() { $('#word-count').textContent = String(state.words.length); }

  /* ============================ 文章载入 ============================ */
  function loadArticle(text, title) {
    stopSpeaking();
    state.analysis = {};
    const sents = splitSentences(text);
    if (!sents.length) { toast('没读到英文内容，检查一下粘贴的文本'); return; }
    state.sentences = sents;
    state.title = title || '';
    LS.set('title', state.title);
    renderReader();
    $('#panel-inner').innerHTML = emptyPanelHTML();
    state.current = -1;
    // 只先选第一句：本地语法分析立刻可见（证明交互正常），
    // 其余句子点哪句译哪句，避免离线时 13 句排队干等把页面拖死。
    if (state.sentences.length) selectSentence(0, { scroll: false });
  }

  function emptyPanelHTML() {
    return '<div class="panel-hint">' +
      '<b>怎么用</b><ul>' +
      '<li>点 <b>▶</b> 开始朗读，句子会逐句高亮，读完自动跳到下一句。</li>' +
      '<li>点任意一句 → 右侧给出中文翻译和语法结构拆解。</li>' +
      '<li>点任意一个单词 → 音标、中文释义、英文释义、发音。</li>' +
      '<li>带 <span style="border-bottom:1.5px dotted var(--amber);color:var(--amber)">虚线下划</span> 的是固定搭配，点一下能看到含义。</li>' +
      '<li>勾选「只标课标词」后，<span style="border-bottom:2px solid var(--accent)">加粗实线下划</span> 的是本课标词（教育部课标词汇表），只标课程要考的词；可在「课标」里切换小学／初中／高中。</li>' +
      '<li>空格键播放／暂停，← → 切换句子。</li>' +
      '</ul></div>';
  }

  /* ============================ 弹窗 ============================ */
  function openModal(id) { $('#' + id).classList.remove('hidden'); }
  function closeModals() { $$('.modal').forEach((m) => m.classList.add('hidden')); }

  function renderSamples() {
    const list = $('#samples-list');
    list.innerHTML = DATA.samples.map((s, i) =>
      '<div class="sample-item" data-sample="' + i + '"><b>' + esc(s.title) + '</b>' +
      (s.level ? '<span class="sample-level">' + esc(s.level) + '</span>' : '') +
      '<small>' + esc(s.text.slice(0, 90).replace(/\s+/g, ' ')) + '…</small></div>').join('');
    $$('.sample-item', list).forEach((el) => {
      el.addEventListener('click', () => {
        const s = DATA.samples[Number(el.dataset.sample)];
        closeModals();
        loadArticle(s.text, s.title);
        toast('已载入示例：' + s.title);
      });
    });
  }

  function renderWords() {
    const list = $('#words-list');
    if (!state.words.length) {
      list.innerHTML = '<p class="hint">还没有收藏单词。点文章里的单词，在卡片上点“＋ 生词本”。</p>';
      return;
    }
    list.innerHTML = state.words.map((w, i) =>
      '<div class="word-row"><span class="ww">' + esc(w.w) + '</span>' +
      '<span class="wi">' + esc(w.ipa || '') + '</span>' +
      '<span class="wm">' + esc(w.zh || '') + '</span>' +
      '<button data-say="' + i + '">发音</button>' +
      '<button data-del="' + i + '">删除</button></div>').join('');
    $$('[data-say]', list).forEach((b) => b.addEventListener('click', () => speakWord(state.words[Number(b.dataset.say)].w)));
    $$('[data-del]', list).forEach((b) => b.addEventListener('click', () => {
      state.words.splice(Number(b.dataset.del), 1);
      LS.set('words', state.words);
      updateWordCount();
      renderWords();
    }));
  }

  function exportWords() {
    if (!state.words.length) { toast('生词本是空的'); return; }
    const lines = state.words.map((w, i) => (i + 1) + '. ' + w.w + (w.ipa ? '  ' + w.ipa : '') + (w.zh ? '  —  ' + w.zh : ''));
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '生词本.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  /* ============================ 设置 ============================ */
  function syncSettingsUI() {
    $$('input[name=provider]').forEach((r) => { r.checked = r.value === state.provider; });
    $('#ai-fields').classList.toggle('on', state.provider === 'ai');
    $('#ai-base').value = state.ai.base || '';
    $('#ai-model').value = state.ai.model || '';
    $('#ai-key').value = state.ai.key || '';
  }

  /* ============================ 绑定事件 ============================ */
  function bind() {
    // 播放控制
    $('#btn-play').addEventListener('click', togglePlay);
    $('#btn-prev').addEventListener('click', () => {
      state.playing = false; updatePlayBtn();
      const i = Math.max(0, (state.current < 0 ? 0 : state.current) - 1);
      selectSentence(i, { scroll: true });
    });
    $('#btn-next').addEventListener('click', () => {
      state.playing = false; updatePlayBtn();
      const i = Math.min(state.sentences.length - 1, (state.current < 0 ? -1 : state.current) + 1);
      selectSentence(i, { scroll: true });
    });
    $('#rate').addEventListener('input', (e) => {
      state.rate = Number(e.target.value);
      LS.set('rate', state.rate);
      $('#rate-label').textContent = state.rate.toFixed(2) + '×';
      if (state.playing) speak(state.current);   // 生效重读当前句
    });
    $('#voice').addEventListener('change', (e) => {
      state.voiceURI = e.target.value;
      LS.set('voiceURI', state.voiceURI);
    });
    $('#dictation').addEventListener('change', (e) => {
      state.dictation = e.target.checked;
      LS.set('dictation', state.dictation);
      renderReader();
      if (state.dictation && state.sentences.length) startDictation(0);
    });
    $('#bilingual').addEventListener('change', (e) => {
      state.bilingual = e.target.checked;
      LS.set('bilingual', state.bilingual);
      document.body.classList.toggle('bilingual', state.bilingual);
      if (state.bilingual) backfillTranslations();
    });
    $('#course-only').addEventListener('change', (e) => {
      state.courseOnly = e.target.checked;
      LS.set('courseOnly', state.courseOnly);
      if (state.courseOnly) ensureCourseSet();
      renderReader();
      if (state.current >= 0) renderPanel(state.current, {});
    });
    $('#course-tier').addEventListener('change', (e) => {
      state.courseTier = e.target.value;
      LS.set('courseTier', state.courseTier);
      COURSE_TIER_KEY = null; // 强制重建词集
      if (state.courseOnly) ensureCourseSet();
      renderReader();
      if (state.current >= 0) renderPanel(state.current, {});
    });

    // 标题
    $('#article-title').addEventListener('change', (e) => {
      state.title = e.target.value.trim();
      LS.set('title', state.title);
      document.title = (state.title || '精读台') + ' · 精读台';
    });

    // 顶栏
    $('#btn-import').addEventListener('click', () => {
      $('#import-text').value = '';
      $('#import-title').value = '';
      $('#import-count').textContent = '';
      openModal('modal-import');
    });
    $('#btn-samples').addEventListener('click', () => { renderSamples(); openModal('modal-samples'); });
    $('#btn-words').addEventListener('click', () => { renderWords(); openModal('modal-words'); });
    $('#btn-settings').addEventListener('click', () => { syncSettingsUI(); openModal('modal-settings'); });

    $$('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
    $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));

    // 导入
    $('#import-text').addEventListener('input', (e) => {
      const n = (e.target.value.match(/[A-Za-z]+/g) || []).length;
      $('#import-count').textContent = n ? n + ' 个英文词' : '';
    });
    $('#import-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        $('#import-text').value = String(rd.result || '');
        if (!$('#import-title').value) $('#import-title').value = f.name.replace(/\.[^.]+$/, '');
        $('#import-text').dispatchEvent(new Event('input'));
      };
      rd.readAsText(f);
    });
    $('#btn-import-ok').addEventListener('click', () => {
      const text = $('#import-text').value.trim();
      if (!text) { toast('先粘贴或选择一篇文章'); return; }
      const title = $('#import-title').value.trim() || '未命名文章';
      closeModals();
      loadArticle(text, title);
      toast('已载入，共 ' + state.sentences.length + ' 句');
    });

    // 设置保存 / 测试
    $$('input[name=provider]').forEach((r) => r.addEventListener('change', () => {
      state.provider = $('input[name=provider]:checked').value;
      LS.set('provider', state.provider);
      $('#ai-fields').classList.toggle('on', state.provider === 'ai');
      state.tcache = {};
      NET_FAIL = false; netBannerOpen = false;
      const b = document.getElementById('status-banner'); if (b) b.classList.add('hidden');
    }));
    $('#btn-save-settings').addEventListener('click', () => {
      state.ai = {
        base: $('#ai-base').value.trim() || 'https://api.deepseek.com/v1',
        model: $('#ai-model').value.trim() || 'deepseek-chat',
        key: $('#ai-key').value.trim(),
      };
      LS.set('ai', state.ai);
      state.tcache = {};
      state.analysis = {};
      NET_FAIL = false; netBannerOpen = false;
      const b = document.getElementById('status-banner'); if (b) b.classList.add('hidden');
      closeModals();
      toast('设置已保存');
      if (state.sentences.length) renderReader();
    });
    $('#btn-test-ai').addEventListener('click', async () => {
      const out = $('#ai-test-result');
      const backup = state.ai;
      state.ai = {
        base: $('#ai-base').value.trim(),
        model: $('#ai-model').value.trim(),
        key: $('#ai-key').value.trim(),
      };
      out.textContent = '测试中…';
      out.className = 'test-result';
      try {
        const r = await aiChat([{ role: 'user', content: '只回复两个字：可用' }]);
        out.textContent = '连接成功：' + String(r).slice(0, 20);
        out.className = 'test-result ok';
      } catch (e) {
        out.textContent = '失败：' + e.message + '（也可能是该服务不允许浏览器直接调用）';
        out.className = 'test-result bad';
        state.ai = backup;
      }
    });

    // 生词本导出
    $('#btn-export-words').addEventListener('click', exportWords);

    // 键盘
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowLeft') { $('#btn-prev').click(); }
      else if (e.key === 'ArrowRight') { $('#btn-next').click(); }
      else if (e.key === 'Escape') { closeModals(); closeCard(); }
    });

    // 点空白关卡片
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#wordcard') && !e.target.closest('.w')) closeCard();
    });

    // 语音列表
    if (synth) {
      loadVoices();
      synth.addEventListener && synth.addEventListener('voiceschanged', loadVoices);
      synth.onvoiceschanged = loadVoices;
      setTimeout(loadVoices, 300);
      setTimeout(loadVoices, 1200);
    }

    window.addEventListener('beforeunload', () => { if (synth) synth.cancel(); });
  }

  /* ============================ 启动 ============================ */
  function init() {
    try {
      buildCollocations();
      bind();
      document.body.classList.toggle('bilingual', state.bilingual);
      $('#bilingual').checked = state.bilingual;
      $('#course-only').checked = state.courseOnly;
      $('#course-tier').value = state.courseTier;
      if (state.courseOnly) ensureCourseSet();
      $('#rate').value = state.rate;
      $('#rate-label').textContent = Number(state.rate).toFixed(2) + '×';
      updateWordCount();
      $('#panel-inner').innerHTML = emptyPanelHTML();
      const first = DATA.samples[0];
      if (first) loadArticle(first.text, first.title);
      else toast('没有可用的示例文章，点“导入文章”粘贴一段英文试试');
    } catch (e) {
      console.error(e);
      const p = document.getElementById('panel-inner');
      if (p) p.innerHTML = '<div class="panel-hint"><b>页面初始化出错</b><p>' +
        esc(String((e && e.message) || e)) + '</p>' +
        '<p>多半是某个脚本加载被拦截。请刷新页面，或换 Chrome / Edge 打开；若仍不行，到浏览器控制台把红色报错发我。</p></div>';
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
