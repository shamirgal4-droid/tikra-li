'use strict';

// תקריא לי – מצלמים דף ושומעים אותו.
// זיהוי טקסט: Tesseract.js (רץ בתוך הדפדפן). הקראה: Web Speech API (הקול של המכשיר).
// שום תמונה או טקסט לא נשלחים לשרת.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const abs = (path) => new URL(path, location.href).href;

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('tikra:' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('tikra:' + key, JSON.stringify(value)); } catch { /* מצב פרטי וכו' */ }
  },
};

// ─── מצב ─────────────────────────────────────────────────────────────────────

const RATE_MIN = 0.5;
const RATE_MAX = 2;
const RATE_STEP = 0.1;
const MAX_CHUNK = 180;      // משפטים ארוכים מפוצלים – כרום נתקע על הקראות ארוכות
const MAX_IMAGE_SIDE = 2400;

const clampRate = (r) => Math.round(Math.min(RATE_MAX, Math.max(RATE_MIN, Number(r) || 1)) * 10) / 10;

const state = {
  sentences: [],   // { text, lang, el, words: [{ start, end, el }] }
  idx: 0,          // המשפט הנוכחי
  wordIdx: -1,     // המילה הנוכחית בתוך המשפט (לפי אירועי boundary)
  playing: false,
  gen: 0,          // עולה בכל עצירה/התחלה, כדי להתעלם מאירועים של הקראה ישנה
  rate: clampRate(store.get('rate', 1)),
  ocrLang: store.get('ocrLang2', 'mix'),
  fontSize: store.get('fontSize', 24),
  follow: store.get('follow', true),
  pages: [],       // { canvas, text } – לכל דף שצולם, בשביל סיבוב וזיהוי מחדש
  text: '',
};

// ─── עזרים ───────────────────────────────────────────────────────────────────

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function show(view) {
  for (const v of ['home', 'work', 'reader']) $('#view-' + v).hidden = v !== view;
  $('#player').hidden = view !== 'reader';
  $('#homeBtn').hidden = view === 'home';
  $('#main').scrollTop = 0;
  if (view !== 'reader') pause();
  if (view === 'home') $('#resumeBtn').hidden = !store.get('lastText', '');
}

// ─── פירוק טקסט למשפטים ומילים ────────────────────────────────────────────────

const HEB_RE = /[֐-׿יִ-ﭏ]/g;
const LAT_RE = /[A-Za-z]/g;

function detectLang(text, fallback) {
  const he = (text.match(HEB_RE) || []).length;
  const en = (text.match(LAT_RE) || []).length;
  if (!he && !en) return fallback;
  return he >= en ? 'he' : 'en';
}

// נקודה שאחריה ספרה (3.5) לא מסיימת משפט
const SENTENCE_RE = /(?:[^.!?…;:\n]|[.:](?=\d))+(?:[.!?…;:]+["'״”’)\]]*|$)/g;

function splitLong(s) {
  if (s.length <= MAX_CHUNK) return [s];
  const out = [];
  let rest = s;
  while (rest.length > MAX_CHUNK) {
    const window = rest.slice(0, MAX_CHUNK);
    let cut = Math.max(window.lastIndexOf(','), window.lastIndexOf('،'), window.lastIndexOf(' - '));
    if (cut < MAX_CHUNK / 3) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = MAX_CHUNK;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function splitSentences(paragraph) {
  const raw = (paragraph.match(SENTENCE_RE) || []).map((s) => s.trim()).filter(Boolean);
  // מספור של רשימה ("2.") או סימן פיסוק בודד הם לא משפט בפני עצמו
  const merged = [];
  let carry = '';
  for (const s of raw) {
    if (!/\p{L}/u.test(s)) {
      if (/\d/.test(s)) carry += s + ' ';
      continue;
    }
    merged.push(carry + s);
    carry = '';
  }
  if (carry) {
    if (merged.length) merged[merged.length - 1] += ' ' + carry.trim();
    else merged.push(carry.trim());
  }
  return merged.flatMap(splitLong);
}

function render(text) {
  pause();
  state.text = text;
  store.set('lastText', text);
  const root = $('#text');
  root.textContent = '';
  state.sentences = [];
  state.idx = 0;
  state.wordIdx = -1;

  let lang = state.ocrLang === 'eng' ? 'en' : 'he';
  for (const para of text.split(/\n+/)) {
    if (!para.trim()) continue;
    const p = document.createElement('p');
    p.dir = 'auto';
    for (const s of splitSentences(para)) {
      lang = detectLang(s, lang);
      const span = document.createElement('span');
      span.className = 'sentence';
      span.lang = lang;
      span.dataset.i = state.sentences.length;
      const sent = { text: s, lang, el: span, words: [] };
      const re = /\S+/g;
      let m;
      let last = 0;
      while ((m = re.exec(s))) {
        if (m.index > last) span.append(s.slice(last, m.index));
        const w = document.createElement('span');
        w.className = 'word';
        w.dataset.w = sent.words.length;
        w.textContent = m[0];
        sent.words.push({ start: m.index, end: m.index + m[0].length, el: w });
        span.append(w);
        last = re.lastIndex;
      }
      p.append(span, ' ');
      state.sentences.push(sent);
    }
    root.append(p);
  }
  checkVoices();
  updatePlayUI();
}

// ─── קולות ────────────────────────────────────────────────────────────────────

const synth = window.speechSynthesis;

function voicesFor(lang) {
  if (!synth) return [];
  const prefixes = lang === 'he' ? ['he', 'iw'] : ['en'];
  return synth.getVoices().filter((v) => {
    const l = (v.lang || '').toLowerCase().replace('_', '-');
    return prefixes.some((p) => l === p || l.startsWith(p + '-'));
  });
}

function pickVoice(lang) {
  const list = voicesFor(lang);
  const saved = store.get('voice-' + lang, '');
  return list.find((v) => v.voiceURI === saved)
    || (lang === 'en' && list.find((v) => /en-us/i.test(v.lang) && v.localService))
    || list.find((v) => v.localService)
    || list[0]
    || null;
}

function fillVoiceSelect(select, lang) {
  const list = voicesFor(lang);
  const current = pickVoice(lang);
  select.textContent = '';
  if (!list.length) {
    select.append(new Option(lang === 'he' ? 'לא נמצא קול עברי במכשיר' : 'No English voice found', ''));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const v of list) {
    const opt = new Option(`${v.name}${v.localService ? '' : ' (אינטרנט)'}`, v.voiceURI);
    opt.selected = current && v.voiceURI === current.voiceURI;
    select.append(opt);
  }
}

let voicesReady = false;
function checkVoices() {
  const warn = $('#voiceWarning');
  if (!synth) {
    warn.textContent = 'הדפדפן הזה לא תומך בהקראה. נסו לפתוח את הקישור בכרום או בספארי.';
    warn.hidden = false;
    return;
  }
  if (!voicesReady) return;
  const needsHe = state.sentences.some((s) => s.lang === 'he');
  if (needsHe && !voicesFor('he').length) {
    warn.innerHTML = 'לא מצאנו קול עברי במכשיר, אז ייתכן שהעברית לא תוקרא. '
      + 'אפשר להתקין קול עברי בחינם – ההוראות ב<button class="linklike" id="openSettingsLink">הגדרות ⚙️</button>.';
    warn.hidden = false;
    $('#openSettingsLink').onclick = openSettings;
  } else {
    warn.hidden = true;
  }
}

if (synth) {
  const onVoices = () => {
    if (synth.getVoices().length) voicesReady = true;
    checkVoices();
  };
  synth.addEventListener?.('voiceschanged', onVoices);
  onVoices();
  // בחלק מהמכשירים voiceschanged לא נורה אף פעם
  setTimeout(() => { voicesReady = true; checkVoices(); }, 2500);
}

// ─── הקראה ───────────────────────────────────────────────────────────────────

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* לא נתמך / נדחה – לא קריטי */ }
}

function clearHighlight() {
  $$('.sentence.current, .word.current').forEach((el) => el.classList.remove('current'));
}

function highlight(i, w) {
  clearHighlight();
  const sent = state.sentences[i];
  if (!sent) return;
  sent.el.classList.add('current');
  if (w >= 0 && sent.words[w]) sent.words[w].el.classList.add('current');
  if (state.follow) scrollToCurrent(sent.words[w]?.el || sent.el);
}

function scrollToCurrent(el) {
  const main = $('#main');
  const r = el.getBoundingClientRect();
  const m = main.getBoundingClientRect();
  if (r.top < m.top + 40 || r.bottom > m.bottom - 40) {
    main.scrollBy({ top: r.top - m.top - m.height / 3, behavior: 'smooth' });
  }
}

function wordAt(sent, charIndex) {
  let found = 0;
  for (let k = 0; k < sent.words.length; k++) {
    if (sent.words[k].start <= charIndex) found = k; else break;
  }
  return found;
}

function stopSpeech() {
  state.gen++;
  if (synth && (synth.speaking || synth.pending)) {
    synth.cancel();
    return true;
  }
  return false;
}

function speakFrom(i, w = 0) {
  if (!synth) { toast('הדפדפן הזה לא תומך בהקראה'); return; }
  const hadSpeech = stopSpeech();
  if (i < 0) i = 0;
  if (i >= state.sentences.length) { finish(); return; }

  state.idx = i;
  state.wordIdx = Math.max(0, w);
  state.playing = true;
  const gen = state.gen;
  const sent = state.sentences[i];
  const offset = sent.words[state.wordIdx]?.start ?? 0;

  const u = new SpeechSynthesisUtterance(sent.text.slice(offset));
  u.lang = sent.lang === 'he' ? 'he-IL' : 'en-US';
  const voice = pickVoice(sent.lang);
  if (voice) u.voice = voice;
  u.rate = state.rate;
  u.onboundary = (e) => {
    if (gen !== state.gen || (e.name && e.name !== 'word')) return;
    state.wordIdx = wordAt(sent, offset + e.charIndex);
    highlight(state.idx, state.wordIdx);
  };
  u.onend = () => {
    if (gen !== state.gen) return;
    speakFrom(i + 1, 0);
  };
  u.onerror = (e) => {
    if (gen !== state.gen || e.error === 'interrupted' || e.error === 'canceled') return;
    state.playing = false;
    updatePlayUI();
    toast(e.error === 'language-unavailable' || e.error === 'voice-unavailable'
      ? 'אין במכשיר קול מתאים לשפה הזו – ראו הוראות בהגדרות ⚙️'
      : 'ההקראה נעצרה. לחצו שוב על ▶');
  };

  highlight(i, state.wordIdx);
  // ספארי וכרום לפעמים "בולעים" speak שמגיע מיד אחרי cancel
  if (hadSpeech) setTimeout(() => { if (gen === state.gen) synth.speak(u); }, 60);
  else synth.speak(u);
  keepAwake(true);
  updatePlayUI();
}

function pause() {
  if (!state.playing) return;
  state.playing = false;
  stopSpeech();
  keepAwake(false);
  updatePlayUI();
}

function finish() {
  state.playing = false;
  state.idx = 0;
  state.wordIdx = -1;
  clearHighlight();
  keepAwake(false);
  updatePlayUI();
}

function togglePlay() {
  if (state.playing) pause();
  else if (state.sentences.length) speakFrom(state.idx, Math.max(0, state.wordIdx));
}

function updatePlayUI() {
  $('#playIcon').setAttribute('href', state.playing ? '#i-pause' : '#i-play');
  $('#playBtn').setAttribute('aria-label', state.playing ? 'עצירה' : 'הקראה');
}

function jump(delta) {
  const i = Math.min(state.sentences.length - 1, Math.max(0, state.idx + delta));
  if (state.playing) speakFrom(i, 0);
  else { state.idx = i; state.wordIdx = 0; highlight(i, 0); }
}

// ─── מהירות ──────────────────────────────────────────────────────────────────

function rateName(r) {
  if (r < 0.75) return 'איטי מאוד';
  if (r < 0.95) return 'איטי';
  if (r <= 1.05) return 'רגיל';
  if (r <= 1.45) return 'מהיר';
  return 'מהיר מאוד';
}

let rateTimer;
function setRate(r) {
  state.rate = clampRate(r);
  store.set('rate', state.rate);
  $('#speed').value = state.rate;
  $('#speedValue').innerHTML = `${rateName(state.rate)} <bdi dir="ltr">×${state.rate.toFixed(1)}</bdi>`;
  for (const b of $$('.presets button')) b.classList.toggle('active', Number(b.dataset.rate) === state.rate);
  $('#slower').disabled = state.rate <= RATE_MIN;
  $('#faster').disabled = state.rate >= RATE_MAX;
  // אי אפשר לשנות מהירות של הקראה שכבר רצה – ממשיכים מאותה מילה במהירות החדשה
  if (state.playing) {
    clearTimeout(rateTimer);
    rateTimer = setTimeout(() => { if (state.playing) speakFrom(state.idx, state.wordIdx); }, 300);
  }
}

// ─── זיהוי טקסט (OCR) ─────────────────────────────────────────────────────────

const OCR_LANGS = { heb: ['heb'], eng: ['eng'], mix: ['heb', 'eng'] };
const PSM_AUTO = '3';    // פריסה אוטומטית – ברירת המחדל של tesseract.js היא "גוש אחד", שנכשל בטבלאות
const PSM_SPARSE = '11'; // מילים מפוזרות – לטבלאות ורשימות
let workerPromise = null;
let workerLangs = '';
let onOcrProgress = null;

function getWorker(langs = OCR_LANGS[state.ocrLang] || OCR_LANGS.mix) {
  if (!workerPromise) {
    workerLangs = langs.join('+');
    workerPromise = Tesseract.createWorker(langs, 1, {
      workerPath: abs('vendor/tesseract/worker.min.js'),
      corePath: abs('vendor/tesseract/core'),
      langPath: abs('vendor/lang'),
      workerBlobURL: false,
      logger: (m) => onOcrProgress && onOcrProgress(m),
    });
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise.then(async (worker) => {
    if (workerLangs !== langs.join('+')) {
      await worker.reinitialize(langs, 1);
      workerLangs = langs.join('+');
    }
    return worker;
  });
}

async function fileToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function rotateCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.height;
  c.height = src.width;
  const ctx = c.getContext('2d');
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  return c;
}

// מיישר תאורה (צל של היד/טלפון) ומחדד ניגודיות – משפר מאוד זיהוי בצילומי טלפון
function preprocess(src) {
  const w = src.width;
  const h = src.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
  }

  // הערכת צבע הנייר בכל בלוק (אחוזון 90 – כך שהאותיות לא "מחשיכות" את הרקע)
  const B = 32;
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  let bg = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      const x0 = bx * B;
      const y0 = by * B;
      const x1 = Math.min(w, x0 + B);
      const y1 = Math.min(h, y0 + B);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[gray[y * w + x]]++;
      const target = (x1 - x0) * (y1 - y0) * 0.9;
      let acc = 0;
      let v = 0;
      while (v < 255 && (acc += hist[v]) < target) v++;
      bg[by * bw + bx] = Math.max(v, 1);
    }
  }
  // החלקה: מקסימום 3x3 (לכותרות כהות) ואז ממוצע 3x3 פעמיים
  const pass = (fn) => {
    const out = new Float32Array(bg.length);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const vals = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) vals.push(bg[yy * bw + xx]);
          }
        }
        out[y * bw + x] = fn(vals);
      }
    }
    bg = out;
  };
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  pass((a) => Math.max(...a));
  pass(mean);
  pass(mean);

  // נרמול כל פיקסל לפי הרקע שלו (אינטרפולציה בילינארית בין בלוקים)
  const norm = new Uint8ClampedArray(w * h);
  const histN = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, y / B - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, x / B - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const tx = fx - x0;
      const b = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty)
        + (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty;
      const v = Math.min(255, (gray[y * w + x] * 255) / b);
      norm[y * w + x] = v;
      histN[norm[y * w + x]]++;
    }
  }
  // מתיחת ניגודיות: האחוזון ה-1 הכי כהה הופך לשחור
  let lo = 0;
  let acc = 0;
  while (lo < 254 && (acc += histN[lo]) < w * h * 0.01) lo++;
  const span = Math.max(1, 245 - lo);
  for (let i = 0, p = 0; i < norm.length; i++, p += 4) {
    const v = Math.min(255, Math.max(0, ((norm[i] - lo) * 255) / span));
    d[p] = d[p + 1] = d[p + 2] = v;
    d[p + 3] = 255;
  }
  removeLines(d, w, h);
  ctx.putImageData(img, 0, 0);
  return c;
}

// מוחק קווים ארוכים (טבלאות, שורות למילוי, קו תחתון) – הם מבלבלים את זיהוי הפריסה.
// קו = ריצה כהה רציפה ארוכה בהרבה מגובה של אות.
function removeLines(d, w, h) {
  const dark = (i) => d[i * 4] < 128;
  const kill = new Uint8Array(w * h);
  const minH = Math.max(60, w * 0.12);
  const minV = Math.max(60, h * 0.035);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w;) {
      if (!dark(y * w + x)) { x++; continue; }
      let e = x;
      while (e < w && dark(y * w + e)) e++;
      if (e - x >= minH) for (let k = x; k < e; k++) kill[y * w + k] = 1;
      x = e;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h;) {
      if (!dark(y * w + x)) { y++; continue; }
      let e = y;
      while (e < h && dark(e * w + x)) e++;
      if (e - y >= minV) for (let k = y; k < e; k++) kill[k * w + x] = 1;
      y = e;
    }
  }
  // מוחקים גם פיקסל אחד מסביב – קווים בצילום הם מטושטשים בשוליים
  for (let i = 0; i < kill.length; i++) {
    if (!kill[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h) {
          const p = (yy * w + xx) * 4;
          d[p] = d[p + 1] = d[p + 2] = 255;
        }
      }
    }
  }
}

function meaningful(line) {
  const compact = line.replace(/\s/g, '');
  if (!compact) return false;
  const letters = (compact.match(/[א-תA-Za-z0-9]/g) || []).length;
  return letters >= 2 && letters / compact.length >= 0.5;
}

const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;
const FILL_LINES = /_{2,}|\.{4,}|…{2,}/g;   // שורות ריקות למילוי בדפי עבודה
const MIN_EDGE_CONF = 45;  // "מילים" לא בטוחות בקצה שורה הן כמעט תמיד לכלוך/צל
const LIST_ITEM = /^(?:\d{1,2}[.)]?|[א-ת][.)]|[•●▪◦*\-–])\s/;  // 1. / א. / • – כל סעיף בשורה משלו

const QUOTES = /['"“”„‘’`]/;
function cleanWord(text) {
  let t = text.replace(BIDI_MARKS, '').replace(/[|¦]/g, '').replace(FILL_LINES, '').trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return /^[.,!?;:…-]+$/.test(t) ? t : '';
  // מרכאה פותחת בלי סוגרת היא כמעט תמיד שארית של קו או לכלוך
  if (QUOTES.test(t[0]) && !QUOTES.test(t[t.length - 1])) t = t.slice(1);
  return t;
}

// מילה "אמיתית" בקצה שורה: רק אותיות של שפה אחת, באורך סביר
const REAL_WORD = /^(?:[\u05D0-\u05EA]{3,}|[A-Za-z]{3,})[.,!?:;]?$/;
const keepEdge = (w) => w.confidence >= MIN_EDGE_CONF || (w.confidence >= 25 && REAL_WORD.test(w.text));

// בונה טקסט מהמבנה של Tesseract: מסנן רעש, מחבר שורות לפסקאות
// ושומר כותרות ושורות קצרות כפסקה נפרדת (כדי שלא יוקראו כהמשך של המשפט הבא)
function ocrToText(data) {
  if (!data.blocks?.length) return cleanOcr(data.text || '');
  const paras = [];
  for (const block of data.blocks) {
    for (const para of block.paragraphs || []) {
      const lines = [];
      for (const line of para.lines || []) {
        const words = line.words.slice();
        while (words.length && !keepEdge(words[0])) words.shift();
        while (words.length && !keepEdge(words[words.length - 1])) words.pop();
        const text = words.map((w) => cleanWord(w.text)).filter(Boolean).join(' ');
        if (meaningful(text)) lines.push({ text, words: words.length, width: line.bbox.x1 - line.bbox.x0 });
      }
      if (!lines.length) continue;
      const maxWidth = Math.max(...lines.map((l) => l.width));
      let cur = '';
      for (const l of lines) {
        if (cur && (LIST_ITEM.test(l.text) || detectLang(l.text, '') !== detectLang(cur, ''))) {
          paras.push(cur);
          cur = '';
        }
        if (/[A-Za-z]-$/.test(cur)) cur = cur.slice(0, -1) + l.text;
        else cur += (cur ? ' ' : '') + l.text;
        // שורה קצרה (סוף פסקה, כותרת, תא בטבלה, פריט ברשימה) – לא ממשיכה לשורה הבאה
        if (l.width < maxWidth * 0.75 || l.words <= 3) { paras.push(cur); cur = ''; }
      }
      if (cur) paras.push(cur);
    }
  }
  return paras.join('\n');
}

// גיבוי למקרה שאין מבנה מפורט: מחבר שורות לפסקאות ומנקה רעש
function cleanOcr(text) {
  return text
    .replace(/\r/g, '')
    .replace(BIDI_MARKS, '')
    .replace(FILL_LINES, ' ')
    .split(/\n\s*\n/)
    .map((para) => {
      let out = '';
      for (const raw of para.split('\n')) {
        const line = raw.replace(/[|¦]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!meaningful(line)) continue;
        if (/[A-Za-z]-$/.test(out)) out = out.slice(0, -1) + line;
        else out += (out ? ' ' : '') + line;
      }
      return out.trim();
    })
    .filter(Boolean)
    .join('\n');
}

// איכות זיהוי: כמה אותיות זוהו בביטחון גבוה (להשוואה בין ניסיונות),
// וביטחון ממוצע לאות (דף הפוך נותן "מילים" רבות בביטחון נמוך)
const MIN_GOOD_LETTERS = 40;
const MIN_GOOD_CONF = 70;
function quality(data) {
  let score = 0;
  let letters = 0;
  let confSum = 0;
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) {
          const n = (w.text.match(/[\p{L}\p{N}]/gu) || []).length;
          letters += n;
          confSum += n * w.confidence;
          if (w.confidence >= 60) score += n;
        }
      }
    }
  }
  return { score, conf: letters ? confSum / letters : 0 };
}
const isGood = (r) => r.score >= MIN_GOOD_LETTERS && r.conf >= MIN_GOOD_CONF;

function showPreview(canvas) {
  const preview = $('#preview');
  const s = Math.min(1, 900 / canvas.width);
  preview.width = Math.round(canvas.width * s);
  preview.height = Math.round(canvas.height * s);
  preview.getContext('2d').drawImage(canvas, 0, 0, preview.width, preview.height);
}

// מזהה דף. אם הניסיון הראשון חלש: מנסה בלי עיבוד מקדים, ואז בכל הכיוונים
// (טלפונים שומרים לפעמים תמונה על הצד). הכיוון הטוב נשמר בדף.
async function recognizePage(page, { autoRotate = true } = {}) {
  showPreview(page.canvas);
  const bar = $('#workBar');
  const label = $('#workText');
  const hint = $('#workHint');
  let attempt = 'מזהה טקסט…';
  bar.style.width = '3%';
  label.textContent = 'מכין את מנוע הזיהוי…';
  hint.textContent = 'בפעם הראשונה זה לוקח קצת יותר זמן. אחר כך זה מהיר יותר ועובד גם בלי אינטרנט.';
  onOcrProgress = (m) => {
    if (m.status === 'recognizing text') {
      label.textContent = `${attempt} ${Math.round(m.progress * 100)}%`;
      bar.style.width = `${10 + m.progress * 90}%`;
    } else if (/loading/.test(m.status)) {
      bar.style.width = `${3 + (m.progress || 0) * 7}%`;
    }
  };

  try {
    let worker = await getWorker();
    hint.textContent = '';
    const run = async (canvas, pre, psm = PSM_AUTO) => {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(pre ? preprocess(canvas) : canvas, {}, { blocks: true, text: true });
      return { data, canvas, pre, psm, ...quality(data) };
    };

    let best = await run(page.canvas, true);
    if (!isGood(best)) {
      attempt = 'מנסה שוב בדרך אחרת…';
      for (const [pre, psm] of [[true, PSM_SPARSE], [false, PSM_AUTO]]) {
        const r = await run(page.canvas, pre, psm);
        if (r.score > best.score) best = r;
        if (isGood(best)) break;
      }
    }
    if (!isGood(best) && state.ocrLang !== 'mix') {
      // אולי נבחרה שפה לא נכונה (למשל English על דף בעברית) – מנסים עם שתי השפות
      attempt = 'מנסה עם עברית ואנגלית…';
      worker = await getWorker(OCR_LANGS.mix);
      const r = await run(page.canvas, true);
      if (r.score > best.score) best = r;
    }
    if (autoRotate && !isGood(best)) {
      // דף הפוך הוא המקרה הנפוץ (על הצד Tesseract מזהה לבד) – מנסים אותו ראשון
      const r90 = rotateCanvas(page.canvas);
      const r180 = rotateCanvas(r90);
      const r270 = rotateCanvas(r180);
      hint.textContent = 'נראה שהתמונה הפוכה או על הצד – מחפשים את הכיוון הנכון.';
      for (const [k, c] of [r180, r90, r270].entries()) {
        attempt = `מנסה לסובב את התמונה (${k + 1}/3)…`;
        showPreview(c);
        const r = await run(c, true);
        if (r.score > best.score) best = r;
        if (isGood(best)) break;
      }
    }
    if (state.ocrLang === 'mix' && isGood(best)) {
      const text = best.data.text || '';
      const he = (text.match(HEB_RE) || []).length;
      const en = (text.match(LAT_RE) || []).length;
      const single = he >= (he + en) * 0.9 ? ['heb'] : en >= (he + en) * 0.9 ? ['eng'] : null;
      if (single) {
        attempt = 'משפר את הדיוק…';
        const w1 = await getWorker(single);
        await w1.setParameters({ tessedit_pageseg_mode: best.psm });
        const { data } = await w1.recognize(best.pre ? preprocess(best.canvas) : best.canvas, {}, { blocks: true, text: true });
        const q = quality(data);
        if (q.score >= best.score * 0.9) best = { ...best, data, ...q };
      }
    }
    page.canvas = best.canvas;
    // אם הסינון הקפדני מחק הכל – עדיף טקסט עם קצת רעש מאשר כלום
    return ocrToText(best.data) || cleanOcr(best.data.text || '');
  } finally {
    onOcrProgress = null;
  }
}

async function handleFiles(files, { append = false } = {}) {
  files = Array.from(files || []).filter((f) => f.type.startsWith('image/') || !f.type);
  if (!files.length) return;
  if (typeof Tesseract === 'undefined') { toast('מנוע הזיהוי לא נטען. בדקו חיבור לאינטרנט ונסו שוב.'); return; }
  if (!append) state.pages = [];
  show('work');
  try {
    for (const file of files) {
      const canvas = await fileToCanvas(file);
      const page = { canvas, text: '' };
      state.pages.push(page);
      page.text = await recognizePage(page);
    }
    openReaderFromPages();
  } catch (err) {
    console.error(err);
    toast(`משהו השתבש בזיהוי. נסו שוב, או צלמו מחדש. (${String(err?.message || err).slice(0, 80)})`, 8000);
    show(state.text ? 'reader' : 'home');
  }
}

function openReaderFromPages() {
  const text = state.pages.map((p) => p.text).filter(Boolean).join('\n');
  $('#rotateBtn').hidden = !state.pages.length;
  render(text);
  showReader();
  if (!text.trim()) {
    $('#text').innerHTML = '<p>לא מצאנו טקסט בתמונה 🙁</p>'
      + '<p>נסו <b>↻ סיבוב וזיהוי מחדש</b>, או צלמו שוב: ישר מלמעלה, באור טוב ובלי צל.</p>';
  }
}

function showReader() {
  show('reader');
  if (history.state?.view !== 'reader') history.pushState({ view: 'reader' }, '');
}

function goHome() {
  closeEditor(false);
  if (history.state?.view === 'reader') history.back(); // popstate יחזיר למסך הבית
  else show('home');
}

async function rotateLastPage() {
  const page = state.pages[state.pages.length - 1];
  if (!page) return;
  page.canvas = rotateCanvas(page.canvas);
  show('work');
  try {
    page.text = await recognizePage(page, { autoRotate: false });
  } catch (err) {
    console.error(err);
    toast('משהו השתבש בזיהוי. נסו שוב.');
  }
  openReaderFromPages();
}

// ─── עריכה ───────────────────────────────────────────────────────────────────

function openEditor(initial = state.text) {
  pause();
  $('#editArea').value = initial;
  $('#editor').hidden = false;
  $('#text').hidden = true;
  $('.tap-hint').hidden = true;
  $('#player').hidden = true;
  $('#editArea').focus();
}

function closeEditor(save) {
  if (save) {
    const value = $('#editArea').value.trim();
    // הטקסט הערוך מחליף את הזיהוי – אין יותר טעם לסובב ולזהות מחדש
    state.pages = [];
    $('#rotateBtn').hidden = true;
    render(value);
  }
  $('#editor').hidden = true;
  $('#text').hidden = false;
  $('.tap-hint').hidden = false;
  if (!state.text) { show('home'); return; }
  $('#player').hidden = false;
}

// ─── הגדרות ──────────────────────────────────────────────────────────────────

function applyFontSize() {
  state.fontSize = Math.min(44, Math.max(16, state.fontSize));
  document.documentElement.style.setProperty('--reading-size', state.fontSize + 'px');
  store.set('fontSize', state.fontSize);
}

function openSettings() {
  fillVoiceSelect($('#voiceHe'), 'he');
  fillVoiceSelect($('#voiceEn'), 'en');
  $('#followToggle').checked = state.follow;
  const dlg = $('#settings');
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
}

function testVoice(lang) {
  if (!synth) return;
  pause();
  stopSpeech();
  const u = new SpeechSynthesisUtterance(lang === 'he'
    ? 'שלום! ככה נשמעת ההקראה בעברית.'
    : 'Hello! This is how English reading sounds.');
  u.lang = lang === 'he' ? 'he-IL' : 'en-US';
  const v = pickVoice(lang);
  if (v) u.voice = v;
  u.rate = state.rate;
  synth.speak(u);
}

// ─── חיבור אירועים ───────────────────────────────────────────────────────────

function init() {
  applyFontSize();
  setRate(state.rate);

  for (const r of $$('input[name="ocrLang"]')) {
    r.checked = r.value === state.ocrLang;
    r.addEventListener('change', () => { state.ocrLang = r.value; store.set('ocrLang2', r.value); });
  }

  const startWarmup = () => { if (typeof Tesseract !== 'undefined') getWorker().catch(() => {}); };
  for (const id of ['#cameraInput', '#galleryInput', '#addPageInput']) {
    const input = $(id);
    // מתחילים לטעון את מנוע הזיהוי כבר כשהמצלמה נפתחת
    input.addEventListener('click', startWarmup);
    input.addEventListener('change', () => {
      const files = Array.from(input.files);
      input.value = '';
      handleFiles(files, { append: id === '#addPageInput' });
    });
  }

  $('#pasteBtn').addEventListener('click', () => {
    state.pages = [];
    $('#rotateBtn').hidden = true;
    render('');
    showReader();
    openEditor('');
  });
  $('#resumeBtn').addEventListener('click', () => {
    state.pages = [];
    $('#rotateBtn').hidden = true;
    render(store.get('lastText', ''));
    showReader();
  });
  $('#homeBtn').addEventListener('click', goHome);
  // כפתור "אחורה" של הטלפון חוזר למסך הבית במקום לצאת מהאפליקציה
  window.addEventListener('popstate', () => {
    if ($('#view-home').hidden) { closeEditor(false); show('home'); }
  });

  $('#editBtn').addEventListener('click', () => openEditor());
  $('#editDone').addEventListener('click', () => closeEditor(true));
  $('#editCancel').addEventListener('click', () => closeEditor(false));
  $('#rotateBtn').addEventListener('click', rotateLastPage);
  $('#fromStartBtn').addEventListener('click', () => speakFrom(0, 0));
  $('#fontUp').addEventListener('click', () => { state.fontSize += 2; applyFontSize(); });
  $('#fontDown').addEventListener('click', () => { state.fontSize -= 2; applyFontSize(); });

  $('#text').addEventListener('click', (e) => {
    const s = e.target.closest('.sentence');
    if (!s) return;
    const w = e.target.closest('.word');
    speakFrom(Number(s.dataset.i), w ? Number(w.dataset.w) : 0);
  });

  $('#playBtn').addEventListener('click', togglePlay);
  $('#prevBtn').addEventListener('click', () => jump(-1));
  $('#nextBtn').addEventListener('click', () => jump(1));
  $('#repeatBtn').addEventListener('click', () => speakFrom(state.idx, 0));

  $('#speed').addEventListener('input', (e) => setRate(e.target.value));
  $('#slower').addEventListener('click', () => setRate(state.rate - RATE_STEP));
  $('#faster').addEventListener('click', () => setRate(state.rate + RATE_STEP));
  for (const b of $$('.presets button')) b.addEventListener('click', () => setRate(b.dataset.rate));

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#voiceHe').addEventListener('change', (e) => store.set('voice-he', e.target.value));
  $('#voiceEn').addEventListener('change', (e) => store.set('voice-en', e.target.value));
  $('#followToggle').addEventListener('change', (e) => { state.follow = e.target.checked; store.set('follow', state.follow); });
  for (const b of $$('[data-test]')) b.addEventListener('click', () => testVoice(b.dataset.test));

  // מקשי קיצור במחשב: רווח = הקראה/עצירה, חצים = מהירות
  document.addEventListener('keydown', (e) => {
    if ($('#view-reader').hidden || !$('#editor').hidden || e.target.closest('input, textarea, select, dialog')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setRate(state.rate + RATE_STEP); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setRate(state.rate - RATE_STEP); }
  });

  // יציאה מהאפליקציה עוצרת את ההקראה (אחרת חלק מהטלפונים ממשיכים לדבר ברקע)
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  show('home');

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
