/* ============================================================
   节拍器 Metronome — 应用逻辑
   ------------------------------------------------------------
   时间精度的关键：
   1) 不用 setInterval 直接发声，只用它做“提前量”粗调度；
   2) 声音一律用 AudioContext 的采样时钟（currentTime）精确排期；
   3) 计时器放在 Web Worker 里，避免后台标签页被限流到 1s；
   4) 视觉反馈也走同一条调度队列，保证看到/听到的一致。

   节奏模型（每拍独立）：
   tracks[拍] = { steps, cells[] }
   - steps：这一拍切成几格（可以每拍不同）
   - cells：每格 0=休止 / 1=点击 / 2=重音
   每拍总时长恒为 60/bpm 秒，格数多的拍每格更短，
   于是「第一拍三连音 + 第二拍前八后十六」可以同时成立。

   音色不单独设置，按位置自动决定：
   落在拍首的用“正拍”音色，落在拍内的用“细分”音色，重音覆盖两者。
   ============================================================ */

'use strict';

/* ------------------------------------------------------------
   1. 常量与配置
   ------------------------------------------------------------ */

const STORAGE_KEY = 'metronome.settings.v3';
const LEGACY_V2 = 'metronome.settings.v2';
const LEGACY_V1 = 'metronome.settings.v1';

const LIMITS = {
  bpmMin: 30, bpmMax: 300,
  beatsMin: 1, beatsMax: 12,
  stepsMin: 1, stepsMax: 8,
};

const DEFAULTS = {
  bpm: 120,
  beatsPerMeasure: 4,
  volume: 0.8,
  sound: 'click',
  latencyMs: 0,
  latencyAuto: true,
  keepAwake: true,
  muted: false,
  theme: 'auto',
};

const LEVEL_NAME = { 0: '休止', 1: '点击', 2: '重音' };

/* 单拍节奏型库：shape 里 1=发声 0=休止，length 就是这一拍的格数 */
const PRESETS = [
  { id: 'quarter',   label: '四分',       steps: 1, shape: [1] },
  { id: 'eighth',    label: '八分',       steps: 2, shape: [1, 1] },
  { id: 'triplet',   label: '三连音',     steps: 3, shape: [1, 1, 1] },
  { id: 'sixteenth', label: '十六分',     steps: 4, shape: [1, 1, 1, 1] },
  { id: 'quintuplet', label: '五连音',    steps: 5, shape: [1, 1, 1, 1, 1] },
  { id: 'sextuplet', label: '六连音',     steps: 6, shape: [1, 1, 1, 1, 1, 1] },
  // 下面几个是“节奏组合”，格数都是 4（十六分网格）
  { id: 'eighth-two16', label: '前八后十六', steps: 4, shape: [1, 0, 1, 1] },
  { id: 'two16-eighth', label: '前十六后八', steps: 4, shape: [1, 1, 1, 0] },
  { id: 'dotted8',   label: '附点八分',   steps: 4, shape: [1, 0, 0, 1] },
  { id: 'offbeat',   label: '反拍',       steps: 2, shape: [0, 1] },
];

/* ------------------------------------------------------------
   2. 节拍轨（track）工具
   ------------------------------------------------------------ */

/** 默认：每拍一格，第一拍重音 */
function defaultTracks(beats) {
  return Array.from({ length: beats }, (_, b) => ({
    steps: 1,
    cells: [b === 0 ? 2 : 1],
  }));
}

/** 把任意来源的数据收敛成合法轨道（尺寸不符补 0，非法值归 0） */
function normalizeTracks(src, beats) {
  return Array.from({ length: beats }, (_, b) => {
    const t = Array.isArray(src) ? src[b] : null;
    const steps = t && Number.isInteger(t.steps) ? clamp(t.steps, LIMITS.stepsMin, LIMITS.stepsMax) : 1;
    const cells = [];
    for (let s = 0; s < steps; s++) {
      const v = t && Array.isArray(t.cells) ? t.cells[s] : undefined;
      cells.push(v === 1 || v === 2 ? v : 0);
    }
    return { steps, cells };
  });
}

/** 改拍数：保留已有拍，新增的拍给「一拍一格」 */
function resizeTracks(src, beats) {
  return Array.from({ length: beats }, (_, b) => {
    const t = src[b];
    return t ? { steps: t.steps, cells: t.cells.slice() } : { steps: 1, cells: [1] };
  });
}

/* ------------------------------------------------------------
   3. 设置读写
   ------------------------------------------------------------ */

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function loadSettings() {
  const out = { ...DEFAULTS };
  let saved = null;

  try {
    const rawV3 = localStorage.getItem(STORAGE_KEY);
    if (rawV3) {
      saved = JSON.parse(rawV3);
    } else {
      const rawV2 = localStorage.getItem(LEGACY_V2);
      const rawV1 = localStorage.getItem(LEGACY_V1);

      if (rawV2) {
        // v2：全局 stepsPerBeat + pattern[拍][格]
        const old = JSON.parse(rawV2);
        const steps = clamp(Number(old.stepsPerBeat) || 1, LIMITS.stepsMin, LIMITS.stepsMax);
        saved = {
          ...old,
          tracks: Array.isArray(old.pattern)
            ? old.pattern.map((row) => ({
                steps,
                cells: Array.isArray(row)
                  ? row.map((v) => (v === 1 || v === 2 ? v : 0))
                  : [],
              }))
            : null,
        };
      } else if (rawV1) {
        // v1：全局均匀细分
        const old = JSON.parse(rawV1);
        const steps = clamp(Number(old.subdivision) || 1, LIMITS.stepsMin, LIMITS.stepsMax);
        const beats = clamp(Number(old.beatsPerMeasure) || 4, LIMITS.beatsMin, LIMITS.beatsMax);
        saved = {
          ...old,
          tracks: Array.from({ length: beats }, (_, b) => ({
            steps,
            cells: Array.from({ length: steps }, (_, s) => (s === 0 ? (b === 0 ? 2 : 1) : 1)),
          })),
        };
      }
    }
  } catch { saved = null; }

  if (saved && typeof saved === 'object') {
    for (const k of ['bpm', 'beatsPerMeasure', 'volume', 'sound',
                     'latencyMs', 'keepAwake', 'muted', 'theme']) {
      if (saved[k] !== undefined && typeof saved[k] === typeof out[k]) out[k] = saved[k];
    }
    if (typeof saved.latencyAuto === 'boolean') out.latencyAuto = saved.latencyAuto;
  }

  out.bpm = clamp(Math.round(out.bpm), LIMITS.bpmMin, LIMITS.bpmMax);
  out.beatsPerMeasure = clamp(out.beatsPerMeasure, LIMITS.beatsMin, LIMITS.beatsMax);
  out.volume = clamp(out.volume, 0, 1);
  out.latencyMs = clamp(out.latencyMs, -300, 300);

  out.tracks = (saved && Array.isArray(saved.tracks))
    ? normalizeTracks(saved.tracks, out.beatsPerMeasure)
    : defaultTracks(out.beatsPerMeasure);

  return out;
}

const settings = loadSettings();

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* 隐私模式等场景忽略 */ }
}

/* ------------------------------------------------------------
   4. 音色
   ------------------------------------------------------------ */

const SOUNDS = {
  click: { type: 'square',   accent: 1680, beat: 1120, sub: 840,  decay: 0.035 },
  wood:  { type: 'triangle', accent: 2350, beat: 1560, sub: 1120, decay: 0.062 },
  beep:  { type: 'sine',     accent: 1050, beat: 790,  sub: 620,  decay: 0.095 },
};

const GAINS = { accent: 0.95, beat: 0.62, sub: 0.26 };

/* ------------------------------------------------------------
   5. 音频引擎
   ------------------------------------------------------------ */

let ctx = null;
let masterGain = null;

function initAudio() {
  if (ctx) return ctx;

  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) throw new Error('当前浏览器不支持 Web Audio API');

  ctx = new Ctor({ latencyHint: 'interactive' });

  masterGain = ctx.createGain();
  masterGain.gain.value = settings.muted ? 0 : settings.volume;
  masterGain.connect(ctx.destination);

  if (settings.latencyAuto) {
    const measured = (Number.isFinite(ctx.outputLatency) && ctx.outputLatency > 0)
      ? ctx.outputLatency
      : (Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0);
    settings.latencyMs = clamp(Math.round(measured * 1000), -300, 300);
    syncLatencyUI();
  }

  updateEngineLabel();
  return ctx;
}

function updateEngineLabel() {
  if (!engineOut || !ctx) return;
  const hz = Math.round(ctx.sampleRate / 1000);
  const base = Number.isFinite(ctx.baseLatency) ? `${(ctx.baseLatency * 1000).toFixed(1)}ms` : '—';
  engineOut.textContent = `${hz}kHz / ${base}`;
}

/**
 * 在音频时钟的 time 时刻排一个点击声。
 * 极短 attack + 指数衰减包络，避免起止爆音。
 */
function scheduleClick(time, role) {
  if (!ctx) return;

  const preset = SOUNDS[settings.sound] || SOUNDS.click;
  const freq = preset[role] ?? preset.beat;
  const peak = (GAINS[role] ?? GAINS.beat) * 0.5;
  const decay = preset.decay;

  const osc = ctx.createOscillator();
  const env = ctx.createGain();

  osc.type = preset.type;
  osc.frequency.setValueAtTime(freq, time);

  env.gain.setValueAtTime(0.0001, time);
  env.gain.exponentialRampToValueAtTime(peak, time + 0.0015);
  env.gain.exponentialRampToValueAtTime(0.0001, time + decay);

  osc.connect(env);
  env.connect(masterGain);

  osc.start(time);
  osc.stop(time + decay + 0.01);
  osc.onended = () => { env.disconnect(); osc.disconnect(); };
}

/* ------------------------------------------------------------
   6. Web Worker 计时器
   ------------------------------------------------------------ */

const TICK_MS = 25;
const SCHEDULE_AHEAD = 0.12;

let fallbackTimer = null;

function createTicker(onTick) {
  const src = `
    let timer = null;
    self.onmessage = (e) => {
      if (e.data === 'start') {
        if (timer !== null) return;
        timer = setInterval(() => self.postMessage('tick'), ${TICK_MS});
      } else if (e.data === 'stop') {
        clearInterval(timer); timer = null;
      }
    };`;
  try {
    const blob = new Blob([src], { type: 'text/javascript' });
    const w = new Worker(URL.createObjectURL(blob));
    w.onmessage = () => onTick();
    return {
      start: () => w.postMessage('start'),
      stop: () => w.postMessage('stop'),
    };
  } catch {
    // 退化方案：主线程 setInterval（后台标签页可能被限流）
    return {
      start: () => { if (fallbackTimer === null) fallbackTimer = setInterval(onTick, TICK_MS); },
      stop: () => { clearInterval(fallbackTimer); fallbackTimer = null; },
    };
  }
}

/* ------------------------------------------------------------
   7. 调度状态机
   ------------------------------------------------------------ */

const state = {
  running: false,
  beat: 0,          // 当前拍
  slot: 0,          // 当前拍内的第几格
  nextNoteTime: 0,
  queue: [],        // 视觉事件 { time, beat, slot, level, isBeatStart }
  rafId: 0,
};

const ticker = createTicker(scheduler);

function scheduler() {
  if (!state.running || !ctx) return;

  const now = ctx.currentTime;
  const beatDuration = 60 / settings.bpm;

  // 容错：休眠/卡顿后落后太多，直接跳到当前，避免“补发”一串迟到的音
  if (state.nextNoteTime < now - 0.25) {
    state.nextNoteTime = now + 0.02;
    state.beat = 0;
    state.slot = 0;
    state.queue.length = 0;
  }

  let guard = 0;
  while (state.nextNoteTime < now + SCHEDULE_AHEAD && guard++ < 512) {
    const track = settings.tracks[state.beat];
    const steps = track ? track.steps : 1;

    scheduleCell(state.nextNoteTime, state.beat, state.slot, track);

    // 关键：每一拍用自己格数算步长，所以拍总时长不变
    state.nextNoteTime += beatDuration / steps;

    state.slot += 1;
    if (state.slot >= steps) {
      state.slot = 0;
      state.beat = (state.beat + 1) % settings.beatsPerMeasure;
    }
  }
}

/** 排一格：休止格只推进时间不发声 */
function scheduleCell(time, beat, slot, track) {
  const level = track && track.cells[slot] !== undefined ? (track.cells[slot] || 0) : 0;
  const isBeatStart = slot === 0;

  if (level > 0 && !settings.muted) {
    const role = level === 2 ? 'accent' : (isBeatStart ? 'beat' : 'sub');
    scheduleClick(time, role);
  }

  state.queue.push({
    time: time + settings.latencyMs / 1000,
    beat,
    slot,
    level,
    isBeatStart,
  });
}

/* ------------------------------------------------------------
   8. 视觉同步
   ------------------------------------------------------------ */

const flashEl = document.getElementById('flash');
const beatsEl = document.getElementById('beats');
let dotEls = [];
let lastLit = -1;
let currentCell = null;
let flashTimer = 0;

function buildBeats() {
  beatsEl.textContent = '';
  dotEls = [];
  for (let i = 0; i < settings.beatsPerMeasure; i++) {
    const d = document.createElement('span');
    d.className = 'pulse-seg' + (i === 0 ? ' is-first' : '');
    beatsEl.appendChild(d);
    dotEls.push(d);
  }
  lastLit = -1;
}

function clearVisual() {
  dotEls.forEach((d) => d.classList.remove('on'));
  lastLit = -1;
  flashEl.classList.remove('on');
  clearPlayhead();
}

function clearPlayhead() {
  if (currentCell) currentCell.classList.remove('is-current');
  currentCell = null;
}

function updatePlayhead(beat, slot) {
  if (!panelEl || panelEl.hasAttribute('hidden')) return;
  const next = cellEls[beat] && cellEls[beat][slot];
  if (next === currentCell) return;
  if (currentCell) currentCell.classList.remove('is-current');
  if (next) next.classList.add('is-current');
  currentCell = next || null;
}

function renderEvent(ev) {
  if (ev.isBeatStart && ev.beat !== lastLit) {
    if (lastLit >= 0 && dotEls[lastLit]) dotEls[lastLit].classList.remove('on');
    const dot = dotEls[ev.beat];
    if (dot) dot.classList.add('on');
    lastLit = ev.beat;
  }

  if (ev.level === 2) {
    flashEl.classList.add('on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flashEl.classList.remove('on'), 70);
  }

  updatePlayhead(ev.beat, ev.slot);
}

function visualLoop() {
  if (!state.running) return;
  const now = ctx ? ctx.currentTime : 0;
  while (state.queue.length && state.queue[0].time <= now) {
    renderEvent(state.queue.shift());
  }
  state.rafId = requestAnimationFrame(visualLoop);
}

/* ------------------------------------------------------------
   9. 启动 / 停止
   ------------------------------------------------------------ */

async function start() {
  if (state.running) return;

  try {
    initAudio();
  } catch (err) {
    console.error(err);
    bpmValueEl.textContent = 'ERR';
    tempoMarkEl.textContent = '浏览器不支持 Web Audio';
    return;
  }

  if (ctx.state !== 'running') {
    try { await ctx.resume(); } catch { /* 忽略 */ }
  }

  state.running = true;
  state.beat = 0;
  state.slot = 0;
  state.queue.length = 0;
  state.nextNoteTime = ctx.currentTime + 0.08;

  ticker.start();
  state.rafId = requestAnimationFrame(visualLoop);

  document.body.classList.add('is-running');
  updatePlayButton();
  requestWakeLock();
}

function stop() {
  if (!state.running) return;

  state.running = false;
  ticker.stop();
  cancelAnimationFrame(state.rafId);
  state.queue.length = 0;
  clearVisual();
  document.body.classList.remove('is-running');
  updatePlayButton();
  releaseWakeLock();
}

function toggle() {
  if (state.running) stop();
  else start();
}

/** 结构变了：归零并重新对齐，避免错位 */
function resyncGrid() {
  state.beat = 0;
  state.slot = 0;
  state.queue.length = 0;
  clearPlayhead();
  if (state.running && ctx) {
    state.nextNoteTime = ctx.currentTime + 0.06;
  }
}

/* ------------------------------------------------------------
   10. 屏幕常亮
   ------------------------------------------------------------ */

let wakeLock = null;

async function requestWakeLock() {
  if (!settings.keepAwake || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* 不可用 */ }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) {
    if (ctx && ctx.state !== 'running') {
      ctx.resume().then(() => {
        state.nextNoteTime = ctx.currentTime + 0.06;
      }).catch(() => {});
    }
    if (!wakeLock) requestWakeLock();
  }
});

/* ------------------------------------------------------------
   11. DOM 引用
   ------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const bpmValueEl = $('bpmValue');
const bpmSlider = $('bpmSlider');
const tempoMarkEl = $('tempoMark');
const playBtn = $('playBtn');
const tapBtn = $('tapBtn');
const muteBtn = $('muteBtn');
const panelBtn = $('panelBtn');
const panelEl = $('panel');

const beatsSeg = $('beatsSeg');
const presetRow = $('presetRow');
const gridEl = $('grid');
const beatsOut = $('beatsOut');
const patternInfo = $('patternInfo');
const patternSummary = $('patternSummary');
const selectedBeatLabel = $('selectedBeatLabel');
const copyAllBtn = $('copyAllBtn');

const volumeInput = $('volumeInput');
const volOut = $('volOut');
const latencyInput = $('latencyInput');
const latOut = $('latOut');
const soundSel = $('soundSel');
const awakeInput = $('awakeInput');
const resetBtn = $('resetBtn');
const engineOut = $('engineOut');
const themeBtn = $('themeBtn');
const themeSeg = $('themeSeg');
const themeOut = $('themeOut');

let cellEls = [];    // 二维：cellEls[拍][格]
let rowEls = [];     // 每拍的行元素
let selectedBeat = 0;

/* ------------------------------------------------------------
   12. 节奏格渲染与编辑
   ------------------------------------------------------------ */

function renderGrid() {
  gridEl.textContent = '';
  cellEls = [];
  rowEls = [];
  clearPlayhead();

  for (let b = 0; b < settings.beatsPerMeasure; b++) {
    const track = settings.tracks[b];

    const rowEl = document.createElement('div');
    rowEl.className = 'grid-row' + (b === selectedBeat ? ' is-selected' : '');
    rowEl.dataset.beat = String(b);

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'grid-label';
    label.textContent = String(b + 1);
    label.setAttribute('aria-label', `第 ${b + 1} 拍，${track.steps} 格，点击选中`);
    label.addEventListener('click', () => selectBeat(b));
    rowEl.appendChild(label);

    const cellsEl = document.createElement('div');
    cellsEl.className = 'grid-cells';
    cellsEl.style.gridTemplateColumns = `repeat(${track.steps}, minmax(0, 1fr))`;

    const rowCells = [];
    for (let s = 0; s < track.steps; s++) {
      const level = track.cells[s];
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.level = String(level);
      cell.dataset.beat = String(b);
      cell.dataset.slot = String(s);
      cell.setAttribute('aria-label', `第 ${b + 1} 拍第 ${s + 1} 格：${LEVEL_NAME[level]}`);
      cell.addEventListener('click', () => cycleCell(b, s));
      cellsEl.appendChild(cell);
      rowCells.push(cell);
    }

    rowEl.appendChild(cellsEl);
    gridEl.appendChild(rowEl);

    cellEls.push(rowCells);
    rowEls.push(rowEl);
  }

  updateSummary();
  updateSelectedLabel();
  syncPresetChips();
}

function selectBeat(b) {
  if (b === selectedBeat) return;
  selectedBeat = b;
  rowEls.forEach((el, i) => el.classList.toggle('is-selected', i === b));
  updateSelectedLabel();
  syncPresetChips();
}

/** 点一下换一种状态：休止 → 点击 → 重音 → 休止 */
function cycleCell(beat, slot) {
  const track = settings.tracks[beat];
  if (!track || track.cells[slot] === undefined) return;

  selectBeat(beat);

  const level = (track.cells[slot] + 1) % 3;
  track.cells[slot] = level;

  const cell = cellEls[beat] && cellEls[beat][slot];
  if (cell) {
    cell.dataset.level = String(level);
    cell.setAttribute('aria-label', `第 ${beat + 1} 拍第 ${slot + 1} 格：${LEVEL_NAME[level]}`);
  }

  syncPresetChips();
  updateSummary();
  saveSettings();

  // 停止状态下给个试听，方便拼节奏
  auditionCell(level, slot === 0);
}

function auditionCell(level, isBeatStart) {
  if (state.running || level === 0) return;
  try { initAudio(); } catch { return; }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const role = level === 2 ? 'accent' : (isBeatStart ? 'beat' : 'sub');
  scheduleClick(ctx.currentTime + 0.02, role);
}

/** 把某一拍的节奏型形状套到目标拍上，保留目标原有的首格重音 */
function applyShape(track, preset) {
  const keepAccent = track.cells[0] === 2;
  track.steps = preset.steps;
  track.cells = preset.shape.map((v, i) => {
    if (v === 0) return 0;
    return i === 0 && keepAccent ? 2 : 1;
  });
}

function applyPresetToBeat(preset, beat) {
  const track = settings.tracks[beat];
  if (!track) return;
  applyShape(track, preset);
  renderGrid();
  resyncGrid();
  saveSettings();
}

function copySelectedToAll() {
  const src = settings.tracks[selectedBeat];
  if (!src) return;
  // 每拍保留自己原有的首格重音，避免复制后所有拍都变重音
  settings.tracks = settings.tracks.map((t) => {
    const clone = { steps: t.steps, cells: t.cells.slice() };
    applyShape(clone, { steps: src.steps, shape: src.cells.map((v) => (v > 0 ? 1 : 0)) });
    return clone;
  });
  renderGrid();
  resyncGrid();
  saveSettings();
}

/* ------------------------------------------------------------
   13. 状态同步
   ------------------------------------------------------------ */

function matchPreset(track) {
  if (!track) return null;
  const shape = track.cells.map((v) => (v > 0 ? 1 : 0));
  for (const p of PRESETS) {
    if (p.steps !== track.steps) continue;
    if (p.shape.length === shape.length && p.shape.every((v, i) => v === shape[i])) return p.id;
  }
  return null;
}

function updateSelectedLabel() {
  selectedBeatLabel.textContent = `第 ${selectedBeat + 1} 拍`;
}

function syncPresetChips() {
  const matched = matchPreset(settings.tracks[selectedBeat]);
  presetRow.querySelectorAll('.preset').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.preset === matched));
  });
}

function updateSummary() {
  const beats = settings.beatsPerMeasure;
  let totalCells = 0;
  let onsets = 0;

  for (const t of settings.tracks) {
    totalCells += t.steps;
    for (const v of t.cells) if (v > 0) onsets++;
  }

  const empty = onsets === 0;

  patternSummary.textContent = empty
    ? `每小节 ${beats} 拍 · 全部休止`
    : `每小节 ${beats} 拍 · 共 ${totalCells} 格`;
  patternSummary.classList.toggle('is-empty', empty);

  patternInfo.textContent = `${beats} 拍 · ${totalCells} 格 · ${onsets} 个音`;
}

/* ------------------------------------------------------------
   14. 其他设置
   ------------------------------------------------------------ */

const TEMPO_MARKS = [
  [40, 'Grave'], [60, 'Largo'], [66, 'Larghetto'], [76, 'Adagio'],
  [108, 'Andante'], [120, 'Moderato'], [156, 'Allegro'], [176, 'Vivace'],
  [Infinity, 'Presto'],
];

function tempoMark(bpm) {
  for (const [limit, name] of TEMPO_MARKS) if (bpm < limit) return name;
  return 'Presto';
}

function paintRange(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

function setBpm(raw, { fromSlider = false } = {}) {
  const bpm = clamp(Math.round(raw), LIMITS.bpmMin, LIMITS.bpmMax);
  settings.bpm = bpm;
  bpmValueEl.textContent = String(bpm);
  if (!fromSlider) bpmSlider.value = String(bpm);
  paintRange(bpmSlider);
  tempoMarkEl.textContent = tempoMark(bpm);
  saveSettings();
}

function syncBeatsSeg() {
  beatsSeg.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.beats) === settings.beatsPerMeasure));
  });
  beatsOut.textContent = String(settings.beatsPerMeasure);
}

function setBeats(n) {
  const beats = clamp(n, LIMITS.beatsMin, LIMITS.beatsMax);
  if (beats === settings.beatsPerMeasure) return;
  settings.beatsPerMeasure = beats;
  settings.tracks = resizeTracks(settings.tracks, beats);
  if (selectedBeat >= beats) selectedBeat = beats - 1;
  buildBeats();
  syncBeatsSeg();
  renderGrid();
  resyncGrid();
  saveSettings();
}

function setVolume(v) {
  settings.volume = clamp(v, 0, 1);
  volOut.textContent = `${Math.round(settings.volume * 100)}%`;
  paintRange(volumeInput);
  if (masterGain) {
    masterGain.gain.setTargetAtTime(settings.muted ? 0 : settings.volume, ctx.currentTime, 0.01);
  }
  saveSettings();
}

function setMuted(m) {
  settings.muted = m;
  muteBtn.setAttribute('aria-pressed', String(m));
  if (masterGain) {
    masterGain.gain.setTargetAtTime(m ? 0 : settings.volume, ctx.currentTime, 0.01);
  }
  saveSettings();
}

function syncLatencyUI() {
  latencyInput.value = String(settings.latencyMs);
  latOut.textContent = `${settings.latencyMs > 0 ? '+' : ''}${settings.latencyMs} ms`;
  paintRange(latencyInput);
}

function updatePlayButton() {
  playBtn.setAttribute('aria-pressed', String(state.running));
  playBtn.setAttribute('aria-label', state.running ? '停止' : '开始');
}

/* ---- 主题 ---- */

const THEME_MODES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
const THEME_BG = { dark: '#0a0d12', light: '#f1f4f9' };

const darkQuery = window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;
const themeColorMeta = document.querySelector
  ? document.querySelector('meta[name="theme-color"]')
  : null;

function resolvedTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return darkQuery && darkQuery.matches ? 'dark' : 'light';
}

function applyTheme() {
  const resolved = resolvedTheme(settings.theme);
  document.documentElement.dataset.theme = resolved;

  if (themeColorMeta) themeColorMeta.setAttribute('content', THEME_BG[resolved]);

  if (themeOut) themeOut.textContent = THEME_LABEL[settings.theme] || THEME_LABEL.auto;

  if (themeSeg) {
    themeSeg.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.theme === settings.theme));
    });
  }

  if (themeBtn) {
    themeBtn.setAttribute(
      'aria-label',
      resolved === 'dark' ? '切换到浅色主题' : '切换到深色主题'
    );
  }
}

function setTheme(mode) {
  settings.theme = THEME_MODES.includes(mode) ? mode : 'auto';
  saveSettings();
  applyTheme();
}

function buildThemeSeg() {
  if (!themeSeg) return;
  themeSeg.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => setTheme(b.dataset.theme));
  });
}

/* 系统主题变化时，仅在「跟随系统」模式下响应 */
if (darkQuery) {
  const onSchemeChange = () => {
    if (settings.theme === 'auto') applyTheme();
  };
  if (darkQuery.addEventListener) darkQuery.addEventListener('change', onSchemeChange);
  else if (darkQuery.addListener) darkQuery.addListener(onSchemeChange);
}

/* ------------------------------------------------------------
   15. 控件构建
   ------------------------------------------------------------ */

function buildBeatsSeg() {
  beatsSeg.textContent = '';
  for (let i = LIMITS.beatsMin; i <= LIMITS.beatsMax; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.beats = String(i);
    b.textContent = String(i);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => setBeats(i));
    beatsSeg.appendChild(b);
  }
}

function buildPresets() {
  presetRow.textContent = '';
  for (const preset of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.dataset.preset = preset.id;
    b.textContent = preset.label;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => applyPresetToBeat(preset, selectedBeat));
    presetRow.appendChild(b);
  }
}

function initUI() {
  buildBeatsSeg();
  buildPresets();
  buildThemeSeg();

  bpmSlider.min = String(LIMITS.bpmMin);
  bpmSlider.max = String(LIMITS.bpmMax);

  setBpm(settings.bpm);
  setVolume(settings.volume);
  syncLatencyUI();

  soundSel.value = settings.sound;
  awakeInput.checked = settings.keepAwake;
  muteBtn.setAttribute('aria-pressed', String(settings.muted));

  syncBeatsSeg();
  buildBeats();
  renderGrid();
  applyTheme();
}

/* ------------------------------------------------------------
   16. 事件绑定
   ------------------------------------------------------------ */

bpmSlider.addEventListener('input', (e) => setBpm(e.target.value, { fromSlider: true }));

$('bpmUp').addEventListener('click', () => setBpm(settings.bpm + 1));
$('bpmDown').addEventListener('click', () => setBpm(settings.bpm - 1));

function bindHold(el, dir) {
  let holdTimer = 0;
  let repeatTimer = 0;
  const tickOnce = () => setBpm(settings.bpm + dir);
  const stopAll = () => { clearTimeout(holdTimer); clearInterval(repeatTimer); };
  el.addEventListener('pointerdown', () => {
    holdTimer = setTimeout(() => { repeatTimer = setInterval(tickOnce, 55); }, 380);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.addEventListener(ev, stopAll));
}
bindHold($('bpmUp'), 1);
bindHold($('bpmDown'), -1);

playBtn.addEventListener('click', toggle);
muteBtn.addEventListener('click', () => setMuted(!settings.muted));
copyAllBtn.addEventListener('click', copySelectedToAll);

/* Tap tempo */

const taps = [];

function tap() {
  const now = performance.now();

  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now);
  if (taps.length > 7) taps.shift();

  tapBtn.classList.add('is-flash');
  setTimeout(() => tapBtn.classList.remove('is-flash'), 110);

  if (taps.length < 2) return;

  const intervals = [];
  for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  if (avg > 0) setBpm(Math.round(60000 / avg));
}

tapBtn.addEventListener('click', tap);

/* 设置面板 */

themeBtn.addEventListener('click', () => {
  setTheme(resolvedTheme(settings.theme) === 'dark' ? 'light' : 'dark');
});

panelBtn.addEventListener('click', () => {
  const open = panelEl.hasAttribute('hidden');
  if (open) panelEl.removeAttribute('hidden');
  else panelEl.setAttribute('hidden', '');
  panelBtn.setAttribute('aria-expanded', String(open));
  if (!open) clearPlayhead();
});

volumeInput.addEventListener('input', (e) => setVolume(Number(e.target.value) / 100));

latencyInput.addEventListener('input', (e) => {
  settings.latencyMs = clamp(Number(e.target.value), -300, 300);
  settings.latencyAuto = false;
  syncLatencyUI();
  saveSettings();
});

soundSel.addEventListener('change', (e) => {
  settings.sound = e.target.value;
  saveSettings();
});

awakeInput.addEventListener('change', (e) => {
  settings.keepAwake = e.target.checked;
  saveSettings();
  if (settings.keepAwake && state.running) requestWakeLock();
  else releaseWakeLock();
});

resetBtn.addEventListener('click', () => {
  stop();
  Object.assign(settings, DEFAULTS);
  settings.tracks = defaultTracks(DEFAULTS.beatsPerMeasure);
  selectedBeat = 0;
  saveSettings();
  if (masterGain) masterGain.gain.value = settings.volume;
  initUI();
});

/* 键盘 */

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case ' ':
    case 'Spacebar':
      e.preventDefault();
      toggle();
      break;
    case 'ArrowUp':
      e.preventDefault();
      setBpm(settings.bpm + (e.shiftKey ? 5 : 1));
      break;
    case 'ArrowDown':
      e.preventDefault();
      setBpm(settings.bpm - (e.shiftKey ? 5 : 1));
      break;
    case 'ArrowRight':
      e.preventDefault();
      setBpm(settings.bpm + (e.shiftKey ? 10 : 5));
      break;
    case 'ArrowLeft':
      e.preventDefault();
      setBpm(settings.bpm - (e.shiftKey ? 10 : 5));
      break;
    case 't':
    case 'T':
      e.preventDefault();
      tap();
      break;
    case 'm':
    case 'M':
      e.preventDefault();
      setMuted(!settings.muted);
      break;
    case 'Escape':
      if (!panelEl.hasAttribute('hidden')) {
        panelEl.setAttribute('hidden', '');
        panelBtn.setAttribute('aria-expanded', 'false');
        clearPlayhead();
      }
      break;
    default:
      break;
  }
});

/* ------------------------------------------------------------
   17. 启动
   ------------------------------------------------------------ */

initUI();
updatePlayButton();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* 调试出口，便于控制台/自动化测试观察 */
window.__metronome = {
  state,
  settings,
  setTheme,
  applyTheme,
  get ctx() { return ctx; },
};
