/**
 * duet-guard — DSH Duet 连接守护（自动断连侦测 + 兜底重连）
 * version: 2.0.0
 *
 * 形态：
 *   1) 浏览器扩展 content script（常驻，随页面自动注入）
 *   2) Tampermonkey 用户脚本（==UserScript== 头部见文件末尾注释）
 *   3) 控制台直接粘贴（同文件，IIFE 自执行）
 *
 * 行为：
 *   - 每 SCAN_MS 扫描一次 Duet 控件（默认 5000ms）
 *   - 断连判定：模式不是 off，但连接标记不绿 / 按钮未按下
 *   - 重连：关闭后重新开启同模式按钮（online→mic, tts_only→speaker）
 *   - 指数退避：2s,4s,8s,16s,30s 封顶
 *   - 尊重用户意图：用户切到 off 立即停止重连并复位
 *   - aria-busy=true 时不抢点击（避免与插件自身状态机打架）
 *   - 录制事件日志（上限 500 条）到 window.__duetGuardLog
 *   - 在 <html> 上标记 data-duet-guard / data-duet-guard-state，供外部核验
 *
 * 不做：不注入网络请求、不读取对话内容、不写 localStorage 业务键。
 */
(function () {
  'use strict';

  var VERSION = '2.0.0';
  if (typeof window === 'undefined') return;
  if (window.__duetGuard && window.__duetGuard.version === VERSION) {
    window.__duetGuard._start();
    return;
  }

  var SCAN_MS = 5000;
  var BACKOFF = [2000, 4000, 8000, 16000, 30000];
  var LOG_MAX = 500;
  var LOG_PREFIX = '[duet-guard]';

  var state = {
    version: VERSION,
    mode: 'off',
    status: 'idle',
    attempts: 0,
    lastHealthyAt: 0,
    lastActionAt: 0,
    log: [],
    timer: null,
    observer: null,
    running: false
  };

  function now() { return Date.now(); }

  function record(kind, detail) {
    var entry = { t: now(), kind: kind, detail: detail || null, status: state.status };
    state.log.push(entry);
    if (state.log.length > LOG_MAX) state.log.shift();
    window.__duetGuardLog = state.log;
    if (window.__duetGuardDebug) {
      try { console.log(LOG_PREFIX, kind, detail); } catch (e) {}
    }
    return entry;
  }

  function controlsEl() {
    return document.querySelector('#dsh-duet-controls') ||
           document.querySelector('[data-duet-controls]');
  }

  function isGreen(el) {
    if (!el) return false;
    var c = getComputedStyle(el).color || '';
    var m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    var r = +m[1], g = +m[2], b = +m[3];
    return g > 150 && g > r + 30 && g > b - 40;
  }

  function snapshot() {
    var root = controlsEl();
    if (!root) return { present: false, mode: 'off', active: false, ready: false, busy: false, root: null };
    var mode = root.dataset.mode || root.getAttribute('data-mode') || 'off';
    var mic = root.querySelector('[data-voice=mic]');
    var spk = root.querySelector('[data-voice=speaker]');
    var mark = root.querySelector('[data-duet-mark]');
    var active = !!((mic && mic.getAttribute('aria-pressed') === 'true') ||
                    (spk && spk.getAttribute('aria-pressed') === 'true'));
    var busy = !!root.querySelector('[aria-busy="true"]');
    return {
      present: true, root: root, mode: mode, active: active,
      ready: mark ? isGreen(mark) : active, busy: busy,
      mic: mic, speaker: spk
    };
  }

  function clickButton(btn) {
    if (!btn) return false;
    var label = btn.getAttribute('aria-label') || btn.getAttribute('data-voice') || '?';
    try {
      btn.click();
      record('click', label);
      return true;
    } catch (e) {
      record('click_error', String(e && e.message || e));
      return false;
    }
  }

  function reconnect(snap) {
    if (!snap || !snap.present || snap.mode === 'off') return false;
    if (snap.busy) { record('skip_busy', snap.mode); return false; }
    if (state.attempts >= BACKOFF.length) {
      state.status = 'giveup';
      record('giveup', { mode: snap.mode, attempts: state.attempts });
      return false;
    }
    state.attempts += 1;
    state.status = 'recovering';
    var delay = BACKOFF[Math.min(state.attempts - 1, BACKOFF.length - 1)];
    var voice = snap.mode === 'online' ? 'mic' : 'speaker';
    record('reconnect_scheduled', { mode: snap.mode, voice: voice, attempt: state.attempts, delay: delay });

    setTimeout(function () {
      var root = controlsEl();
      if (!root) { record('skip_no_controls', null); state.status = 'idle'; return; }
      var s = snapshot();
      if (s.active && s.ready) { record('already_back', null); state.status = 'healthy'; return; }
      var btn = root.querySelector('[data-voice=' + voice + ']');
      if (s.active) {
        record('reconnect_fire_toggle', { voice: voice, attempt: state.attempts });
        clickButton(btn);
        setTimeout(function () {
          var root2 = controlsEl();
          var btn2 = root2 && root2.querySelector('[data-voice=' + voice + ']');
          clickButton(btn2);
        }, 1200);
      } else {
        record('reconnect_fire_single', { voice: voice, attempt: state.attempts });
        clickButton(btn);
      }
    }, delay);
    return true;
  }

  function scan() {
    if (!state.running) return;
    var s = snapshot();
    try {
      document.documentElement.setAttribute('data-duet-guard', VERSION);
      document.documentElement.setAttribute('data-duet-guard-state', state.status + ':' + (s.mode || 'off'));
    } catch (e) {}
    if (!s.present) {
      if (state.status !== 'idle') record('controls_missing', null);
      state.status = 'idle';
      return;
    }
    if (s.mode === 'off') {
      if (state.status !== 'idle' || state.attempts) record('user_off_reset', null);
      state.status = 'idle';
      state.attempts = 0;
      return;
    }
    state.mode = s.mode;
    if (s.active && s.ready) {
      if (state.status !== 'healthy') record('healthy', { mode: s.mode });
      state.status = 'healthy';
      state.lastHealthyAt = now();
      state.attempts = 0;
      return;
    }
    state.status = 'suspect';
    record('suspect', { mode: s.mode, active: s.active, ready: s.ready, busy: s.busy });
    reconnect(s);
  }

  function _start() {
    if (state.running) return;
    state.running = true;
    state.timer = setInterval(scan, SCAN_MS);
    record('start', { version: VERSION, scanMs: SCAN_MS });
    setTimeout(scan, 600);
  }

  function _stop() {
    state.running = false;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.observer) { try { state.observer.disconnect(); } catch (e) {} state.observer = null; }
    state.status = 'idle';
    record('stop', null);
  }

  var api = {
    version: VERSION,
    get status() { return { status: state.status, mode: state.mode, attempts: state.attempts, lastHealthyAt: state.lastHealthyAt }; },
    get log() { return state.log.slice(); },
    scan: scan,
    start: _start,
    stop: _stop,
    _start: _start,
    reset: function () { state.attempts = 0; state.status = 'idle'; record('reset', null); }
  };
  window.__duetGuard = api;
  window.DuetGuard = api;
  _start();
})();
