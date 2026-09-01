/* ── MERIDIAN ────────────────────────────────────────────────────────
   The display name lives in data/index.json → meta.title. Change it
   there and the tab, header and shell prompt all follow; nothing else
   in this file hardcodes it.

   Static site. The curriculum is read-only and versioned in git, split
   one file per chapter:

     data/index.json           meta + principles + chapter order
     data/chapters/m0..m7.json one chapter each, with its weeks inline

   Your progress is a separate file entirely — data/progress.json — held
   in localStorage and, if you configure a GitHub token, mirrored to the
   repo so every device sees the same state.
   ------------------------------------------------------------------ */

const LS_STATE = 'mrd.state';
const LS_TOKEN = 'mrd.token';   // never leaves this browser, never synced
const LS_GH    = 'mrd.gh';

/** Carry over anything saved under the previous key namespace. */
function migrateKeys() {
  for (const [from, to] of [['aier.state', LS_STATE], ['aier.token', LS_TOKEN], ['aier.gh', LS_GH]]) {
    const v = localStorage.getItem(from);
    if (v !== null && localStorage.getItem(to) === null) localStorage.setItem(to, v);
    localStorage.removeItem(from);
  }
}

let ROADMAP = null;
let state   = null;
let current = null;              // selected week id
let tick    = null;              // timer interval
let pushTimer = null;

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const now = () => Date.now();

/* ── state ─────────────────────────────────────────────────────────── */

function blank() {
  return { v: 1, tasks: {}, notes: {}, unlocked: {}, logs: [], timer: null, updatedAt: now() };
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (!raw) return blank();
    const s = JSON.parse(raw);
    return { ...blank(), ...s };
  } catch { return blank(); }
}

function saveState({ sync = true } = {}) {
  state.updatedAt = now();
  try { localStorage.setItem(LS_STATE, JSON.stringify(state)); }
  catch (e) { toast('localStorage write failed: ' + e.message, true); }
  if (sync) schedulePush();
}

/** Set a timestamped value. Per-key timestamps are what make the
 *  cross-device merge safe — last writer per key wins, not per file. */
function setVal(bucket, key, value) {
  state[bucket][key] = { v: value, t: now() };
  saveState();
}
const getVal = (bucket, key, dflt) =>
  state[bucket][key] ? state[bucket][key].v : dflt;

/** Merge two states key-by-key. Newer timestamp wins; logs union by id. */
function merge(a, b) {
  const out = blank();
  for (const bucket of ['tasks', 'notes', 'unlocked']) {
    const keys = new Set([...Object.keys(a[bucket] || {}), ...Object.keys(b[bucket] || {})]);
    for (const k of keys) {
      const x = (a[bucket] || {})[k], y = (b[bucket] || {})[k];
      out[bucket][k] = !x ? y : !y ? x : (x.t >= y.t ? x : y);
    }
  }
  const seen = new Map();
  for (const l of [...(a.logs || []), ...(b.logs || [])]) seen.set(l.id, l);
  out.logs = [...seen.values()].sort((p, q) => p.start - q.start);
  out.timer = a.timer || b.timer || null;
  out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
  return out;
}

/* ── week helpers ──────────────────────────────────────────────────── */

const weeks = () => ROADMAP.weeks;
const weekById = id => weeks().find(w => w.id === id);
const isGap = w => w.status === 'gap';

function pct(w) {
  if (!w.tasks?.length) return 100;
  const done = w.tasks.filter(t => getVal('tasks', t.id, false)).length;
  return Math.round(100 * done / w.tasks.length);
}

/** A week is locked until the previous real week is 60% done. You can
 *  always open it anyway, and you can always override the lock. */
function locked(w) {
  if (getVal('unlocked', w.id, false)) return false;
  if (isGap(w) || w.n <= 1) return false;
  const prev = [...weeks()].filter(x => x.n < w.n && !isGap(x)).pop();
  return prev ? pct(prev) < 60 : false;
}

function todayWeek() {
  const t = new Date().toISOString().slice(0, 10);
  return weeks().find(w => w.start <= t && t <= w.end)
      || [...weeks()].reverse().find(w => w.end < t)
      || weeks()[0];
}

const DAY = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'WEEKEND'];
const round1 = n => (Math.round(n * 10) / 10).toString();

/** JS getDay() is 0=Sun..6=Sat; Sat and Sun share the WEEKEND slot. */
const todaySlot = () => { const g = new Date().getDay(); return (g === 0 || g === 6) ? 6 : g; };

/** Tasks in curriculum order, bucketed by the day each one starts on.
 *  A task bigger than one evening carries `dEnd`, so a group reports the
 *  full range it actually occupies — "WED–FRI", not a fictional "WED". */
function byDay(w) {
  const g = new Map();
  for (const t of w.tasks || []) {
    const d = Math.min(6, Math.max(1, t.d || 6));
    if (!g.has(d)) g.set(d, []);
    g.get(d).push(t);
  }
  return [...g.entries()].sort((a, b) => a[0] - b[0]).map(([d, ts]) => {
    const end = Math.max(d, ...ts.map(t => t.dEnd || t.d || d));
    return { d, end, ts, label: d === end ? DAY[d - 1] : `${DAY[d - 1]}–${DAY[end - 1]}` };
  });
}

const minsFor = id => state.logs.filter(l => l.week === id).reduce((s, l) => s + l.mins, 0);
const totalMins = () => state.logs.reduce((s, l) => s + l.mins, 0);

/** Minutes can be negative — a correction entry subtracts from the total,
 *  so an over-logged session is fixable without deleting the original. */
const fmtH = m => {
  const a = Math.abs(m);
  return `${m < 0 ? '-' : ''}${Math.floor(a / 60)}h ${String(a % 60).padStart(2, '0')}m`;
};

/* ── rendering: sidebar ────────────────────────────────────────────── */

function renderSidebar() {
  const hideDone = $('#hide-done').checked;
  const today = todayWeek();
  const list = $('#week-list');
  list.innerHTML = '';

  for (const ph of ROADMAP.phases) {
    const hd = document.createElement('div');
    hd.className = 'phase-hd';
    hd.innerHTML = `${esc(ph.label)}<span class="g">${esc(ph.goal)}</span>`;
    list.appendChild(hd);

    for (const id of ph.weeks) {
      const w = weekById(id);
      if (!w) continue;
      const p = pct(w), done = p === 100 && !isGap(w);
      if (hideDone && done) continue;

      const el = document.createElement('div');
      el.className = 'wk'
        + (done ? ' done' : '')
        + (isGap(w) ? ' gap' : '')
        + (locked(w) ? ' locked' : '')
        + (w.id === today.id ? ' now' : '')
        + (w.id === current ? ' sel' : '');
      el.innerHTML =
        `<span class="wk-n">${isGap(w) ? '––' : 'W' + String(w.n).padStart(2, '0')}</span>` +
        `<span class="wk-t">${locked(w) ? '🔒 ' : ''}${esc(w.title)}</span>` +
        `<span class="wk-badge${done ? ' ok' : ''}">${isGap(w) ? '' : done ? '✓' : p + '%'}</span>`;
      el.onclick = () => select(w.id);
      list.appendChild(el);
    }
  }
}

/* ── rendering: week pane ──────────────────────────────────────────── */

/** The week's tasks as day blocks. Only the first block containing today
 *  is marked — spans overlap, and two "today" markers help nobody. */
function renderDays(w, today) {
  const groups = byDay(w);
  const slot = todaySlot();
  const nowIdx = w.id === today.id
    ? groups.findIndex(g => slot >= g.d && slot <= g.end) : -1;

  return groups.map(({ ts, label }, i) => `
    <div class="day${i === nowIdx ? ' today' : ''}">
      <span class="day-n">${label}</span>
      <span class="day-h">${round1(ts.reduce((s, t) => s + (t.h || 0), 0))}h</span>
      <span class="day-p">${ts.filter(t => getVal('tasks', t.id, false)).length}/${ts.length}</span>
    </div>
    ${ts.map(t => taskRow(w, t)).join('')}`).join('');
}

/** One task, plus the resources bound to it and its own note box. */
function taskRow(w, t) {
  const done = getVal('tasks', t.id, false);
  const note = getVal('notes', t.id, '');
  const res  = (w.resources || []).filter(r => r.task === t.id);
  return `
  <div class="task ${done ? 'done' : ''}" data-tid="${t.id}">
    <input type="checkbox" id="${t.id}" ${done ? 'checked' : ''}>
    <label for="${t.id}">${esc(t.t)}</label>
    <span class="h">${t.h ? t.h + 'h' : ''}</span>
    <button class="notebtn${note ? ' has' : ''}" data-note="${t.id}"
            title="${note ? 'edit note' : 'add note'}">✎</button>
  </div>
  <div class="task-sub${res.length || note ? '' : ' bare'}">
    ${res.map(r => {
      const read = r.role === 'primary';
      return `<div class="task-res">
        ${read
          ? `<input type="checkbox" class="rchk" id="${r.id}" ${getVal('tasks', r.id, false) ? 'checked' : ''}>`
          : `<span class="rdot">▸</span>`}
        <span class="rrole ${r.role}">${read ? 'read' : 'ref'}</span>
        <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.label)}</a>
      </div>`;
    }).join('')}
    <div class="note-wrap${note ? '' : ' hidden'}" data-notefor="${t.id}">
      <textarea class="tnote" data-tid="${t.id}" spellcheck="false"
        placeholder="what broke · the number you got · what you'd do differently">${esc(note)}</textarea>
    </div>
  </div>`;
}

function renderWeek(w) {
  const today = todayWeek();
  const p = pct(w);
  const tags = [
    w.id === today.id ? '<span class="tag now">◀ current</span>' : '',
    isGap(w) ? '<span class="tag gap">parked</span>' : '',
    p === 100 && !isGap(w) ? '<span class="tag done">complete</span>' : '',
  ].join(' ');

  const html = `
<div class="pane">
  <div class="rule">${'─'.repeat(120)}</div>
  <div class="wk-head">
    <div class="meta" style="margin:6px 0 0">
      <span>${isGap(w) ? 'PARKED' : 'WEEK ' + String(w.n).padStart(2, '0')}</span>
      <span>${w.start} → ${w.end}</span>
      <span>target <b>${w.hours}h</b></span>
      ${tags}
    </div>
    <h1>${esc(w.title)}</h1>
  </div>

  ${locked(w) ? `
  <div class="lockbar">
    <span>🔒 Locked — the previous week is under 60% complete. You can read it anyway; unlocking just clears the marker.</span>
    <button class="btn btn-sm" id="btn-unlock">unlock anyway</button>
  </div>` : ''}

  ${w.why ? `<div class="why">${esc(w.why)}</div>` : ''}

  ${w.tasks?.length ? `
  <h3>plan · ${w.tasks.filter(t => getVal('tasks', t.id, false)).length}/${w.tasks.length} · ${p}%</h3>
  <div id="tasks">${renderDays(w, today)}</div>
  <p class="dim small">Days are a suggested split of this week's hours, not a rule — the order is
  what matters. Slipping a day just shifts the rest along.</p>` : ''}

  ${w.deliverable ? `<div class="deliv">${esc(w.deliverable)}</div>` : ''}
  ${w.checkpoint ? `<div class="check">${esc(w.checkpoint)}</div>` : ''}

  ${(w.resources || []).some(r => !r.task) ? `
  <h3>background · anytime, no laptop needed</h3>
  ${w.resources.filter(r => !r.task).map(r => `
    <div class="res">
      <span class="rtype ${esc(r.type)}">${esc(r.type)}</span>
      <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.label)}</a>
    </div>`).join('')}` : ''}

  ${w.code?.length ? `
  <h3>code</h3>
  ${w.code.map((c, i) => `
    <div class="code">
      <div class="code-hd"><span>${esc(c.label)}</span>
        <button class="btn btn-sm copy" data-i="${i}">copy</button></div>
      <pre><code>${hl(c.body, c.lang)}</code></pre>
    </div>`).join('')}` : ''}

  <h3>time log · ${fmtH(minsFor(w.id))} of ${w.hours}h</h3>
  <div class="timer">
    <span class="clock" id="clock">00:00:00</span>
    <button class="btn" id="btn-timer">start</button>
    <input type="number" id="man-mins" min="-900" max="900" step="5" placeholder="±min">
    <button class="btn" id="btn-add-log">log</button>
    <span class="dim small">negative subtracts — use it to correct an over-log</span>
  </div>
  <div class="hbar"><i id="hbar" style="width:0"></i></div>
  <div class="logs" id="logs"></div>

  <h3>notes</h3>
  <div class="notes-hd">
    <span class="dim small">markdown, autosaved</span>
    <span class="saved hidden" id="saved">saved ✓</span>
  </div>
  <textarea id="notes" spellcheck="false" placeholder="$ what clicked, what broke, links, numbers…">${esc(getVal('notes', w.id, ''))}</textarea>

  <div class="rule" style="margin-top:26px">${'─'.repeat(120)}</div>
  <div class="row">
    ${w.n > 0 ? `<button class="btn" id="btn-prev">‹ prev</button>` : ''}
    <button class="btn" id="btn-next">next ›</button>
  </div>
</div>`;

  $('#main').innerHTML = html;
  wireWeek(w);
}

/* ── events for the current week ───────────────────────────────────── */

function wireWeek(w) {
  // resource "read" checkboxes — tracked, but deliberately not part of week %
  $$('#tasks .rchk').forEach(cb => cb.onchange = () => setVal('tasks', cb.id, cb.checked));

  // per-task notes: toggle the box, autosave, keep the ✎ marker in sync
  $$('.notebtn').forEach(b => b.onclick = () => {
    const wrap = $(`.note-wrap[data-notefor="${b.dataset.note}"]`);
    if (!wrap) return;
    wrap.classList.toggle('hidden');
    if (!wrap.classList.contains('hidden')) wrap.querySelector('textarea').focus();
  });
  $$('.tnote').forEach(ta => {
    let d;
    ta.oninput = () => {
      clearTimeout(d);
      d = setTimeout(() => {
        setVal('notes', ta.dataset.tid, ta.value);
        $(`.notebtn[data-note="${ta.dataset.tid}"]`)?.classList.toggle('has', !!ta.value.trim());
      }, 500);
    };
  });

  $$('#tasks .task input').forEach(cb => cb.onchange = () => {
    setVal('tasks', cb.id, cb.checked);
    cb.closest('.task').classList.toggle('done', cb.checked);
    $(`#tasks`).previousElementSibling.textContent =
      `tasks · ${w.tasks.filter(t => getVal('tasks', t.id, false)).length}/${w.tasks.length} · ${pct(w)}%`;
    renderSidebar(); renderHud();
  });

  const nb = $('#notes'); let nt;
  nb.oninput = () => {
    clearTimeout(nt);
    nt = setTimeout(() => {
      setVal('notes', w.id, nb.value);
      const s = $('#saved'); s.classList.remove('hidden');
      setTimeout(() => s.classList.add('hidden'), 1200);
    }, 500);
  };

  $$('.copy').forEach(b => b.onclick = async () => {
    await navigator.clipboard.writeText(w.code[+b.dataset.i].body);
    b.textContent = 'copied'; setTimeout(() => b.textContent = 'copy', 1200);
  });

  const unlock = $('#btn-unlock');
  if (unlock) unlock.onclick = () => { setVal('unlocked', w.id, true); select(w.id); renderSidebar(); };

  $('#btn-timer').onclick = () => toggleTimer(w.id);
  $('#btn-add-log').onclick = () => {
    const m = parseInt($('#man-mins').value, 10);
    if (!m) return toast('enter minutes — negative to subtract', true);
    // a positive entry means "I just finished m minutes"; a correction is stamped now
    addLog(w.id, m > 0 ? now() - m * 60000 : now(), m);
    $('#man-mins').value = '';
  };

  const prev = $('#btn-prev'), next = $('#btn-next');
  const i = weeks().findIndex(x => x.id === w.id);
  if (prev) prev.onclick = () => select(weeks()[Math.max(0, i - 1)].id);
  if (next) next.onclick = () => select(weeks()[Math.min(weeks().length - 1, i + 1)].id);

  renderLogs(w); startClock();
}

/* ── timer ─────────────────────────────────────────────────────────── */

function toggleTimer(weekId) {
  if (state.timer && state.timer.week === weekId) {
    const mins = Math.max(1, Math.round((now() - state.timer.startedAt) / 60000));
    const started = state.timer.startedAt;
    state.timer = null; saveState({ sync: false });
    addLog(weekId, started, mins);
  } else if (state.timer) {
    toast('a timer is already running on ' + state.timer.week, true);
  } else {
    state.timer = { week: weekId, startedAt: now() };
    saveState({ sync: false });
  }
  const w = weekById(weekId);
  $('#btn-timer').textContent = state.timer ? 'stop' : 'start';
  $('#btn-timer').classList.toggle('on', !!state.timer);
  renderLogs(w); startClock();
}

function addLog(weekId, start, mins) {
  // random suffix so two entries in the same millisecond can't collide on sync
  const id = `${weekId}-${start}-${Math.random().toString(36).slice(2, 7)}`;
  state.logs.push({ id, week: weekId, start, mins });
  saveState();
  renderLogs(weekById(weekId)); renderHud();
}

function startClock() {
  clearInterval(tick);
  const el = $('#clock'); if (!el) return;
  const btn = $('#btn-timer');
  const running = state.timer && state.timer.week === current;
  if (btn) { btn.textContent = running ? 'stop' : 'start'; btn.classList.toggle('on', !!running); }
  const paint = () => {
    const s = running ? Math.floor((now() - state.timer.startedAt) / 1000) : 0;
    el.textContent = [s / 3600, (s % 3600) / 60, s % 60]
      .map(x => String(Math.floor(x)).padStart(2, '0')).join(':');
    el.classList.toggle('run', !!running);
  };
  paint();
  if (running) tick = setInterval(paint, 1000);
}

function renderLogs(w) {
  const box = $('#logs'); if (!box) return;
  const mine = state.logs.filter(l => l.week === w.id).sort((a, b) => b.start - a.start);
  box.innerHTML = mine.length
    ? mine.map(l => `<div class="logrow${l.mins < 0 ? ' neg' : ''}">
        <span>${new Date(l.start).toLocaleString()}${l.mins < 0 ? '  (correction)' : ''}</span>
        <span>${fmtH(l.mins)} <button data-id="${l.id}">✕</button></span></div>`).join('')
    : '<span class="dim">no sessions logged</span>';
  $$('#logs button').forEach(b => b.onclick = () => {
    state.logs = state.logs.filter(l => l.id !== b.dataset.id);
    saveState(); renderLogs(w); renderHud();
    const h = $('#hbar'); if (h) sizeBar(w);
  });
  sizeBar(w);
  const hd = box.previousElementSibling?.previousElementSibling?.previousElementSibling;
  if (hd && hd.tagName === 'H3') hd.textContent = `time log · ${fmtH(minsFor(w.id))} of ${w.hours}h`;
}

function sizeBar(w) {
  const bar = $('#hbar'); if (!bar) return;
  const r = w.hours ? minsFor(w.id) / (w.hours * 60) : 0;
  bar.style.width = Math.max(0, Math.min(100, r * 100)) + '%';
  bar.classList.toggle('over', r >= 1);
}

/* ── hud ───────────────────────────────────────────────────────────── */

function renderHud() {
  const real = weeks().filter(w => !isGap(w));
  const all = real.flatMap(w => w.tasks || []);
  const done = all.filter(t => getVal('tasks', t.id, false)).length;
  const p = all.length ? Math.round(100 * done / all.length) : 0;
  $('#hud-progress').textContent = `${p}% · ${done}/${all.length}`;
  $('#bar-fill').style.width = p + '%';
  const t = todayWeek();
  $('#hud-week').textContent = isGap(t) ? 'parked' : `${t.n} / ${Math.max(...real.map(w => w.n))}`;
  $('#hud-hours').textContent = fmtH(totalMins());
}

/* ── github sync ───────────────────────────────────────────────────── */

/** Repo path of the progress file. The site is served FROM docs/, so the
 *  browser sees /data/progress.json while the API must write the repo
 *  path — docs/data/progress.json. Derived from the URL so it stays right
 *  whether Pages serves /docs or the repo root. */
const DEFAULT_PATH = location.hostname.endsWith('github.io')
  ? 'docs/data/progress.json' : 'data/progress.json';

const ghCfg = () => { try { return JSON.parse(localStorage.getItem(LS_GH)) || {}; } catch { return {}; } };
const ghToken = () => localStorage.getItem(LS_TOKEN) || '';
const ghReady = () => { const c = ghCfg(); return !!(c.owner && c.repo && ghToken()); };

const b64enc = str => {
  const bytes = new TextEncoder().encode(str);
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
};
const b64dec = b64 => {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
};

async function ghFetch(method, body) {
  const c = ghCfg();
  const path = c.path || DEFAULT_PATH;
  const url = `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${path}`
            + (method === 'GET' ? `?ref=${c.branch || 'main'}` : '');
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === 'GET' && res.status === 404) return null;   // first push
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

async function pull({ quiet = false } = {}) {
  if (!ghReady()) return quiet || toast('configure GitHub first (⚙)', true);
  try {
    setSync('…');
    const f = await ghFetch('GET');
    if (!f) { setSync('new'); return quiet || toast('no file at ' + (ghCfg().path || DEFAULT_PATH) + ' — push to create it'); }
    const remote = JSON.parse(b64dec(f.content));
    state = merge(state, remote);
    saveState({ sync: false });
    render(); setSync('ok');
    if (!quiet) toast('pulled + merged');
  } catch (e) { setSync('err'); toast(explain(e), true); }
}

async function push() {
  if (!ghReady()) return toast('configure GitHub first (⚙)', true);
  try {
    setSync('…');
    const existing = await ghFetch('GET');
    let payload = state;
    if (existing) payload = state = merge(state, JSON.parse(b64dec(existing.content)));
    const { timer, ...clean } = payload;                    // timer is device-local
    await ghFetch('PUT', {
      message: `progress: ${new Date().toISOString().slice(0, 16)}`,
      content: b64enc(JSON.stringify(clean, null, 2)),
      branch: ghCfg().branch || 'main',
      ...(existing ? { sha: existing.sha } : {}),
    });
    saveState({ sync: false });
    setSync('ok');
    return true;
  } catch (e) {
    setSync('err');
    toast(explain(e), true);
    return false;
  }
}

/** Turn a raw API error into something actionable. */
function explain(e) {
  const m = String(e.message || e);
  if (m.startsWith('401')) return 'token rejected — expired, or from the wrong GitHub account';
  if (m.startsWith('403')) return 'token lacks permission — needs Contents: Read and write on this repo';
  if (m.startsWith('404')) return 'not found — check owner/repo, and that path starts with docs/';
  if (m.startsWith('409') || m.startsWith('422')) return 'conflict — pull remote first, then push';
  return 'sync failed: ' + m.slice(0, 120);
}

function schedulePush() {
  if (!ghReady()) return;
  clearTimeout(pushTimer);
  setSync('•');
  pushTimer = setTimeout(push, 4000);   // debounce: don't commit on every keystroke
}

const setSync = s => { const e = $('#sync-label'); if (e) e.textContent = ghReady() ? s : 'local'; };

/* ── settings modal ────────────────────────────────────────────────── */

function openSettings() {
  const c = ghCfg();
  $('#gh-owner').value  = c.owner  || '';
  $('#gh-repo').value   = c.repo   || slug();
  $('#gh-branch').value = c.branch || 'main';
  $('#gh-path').value   = c.path   || DEFAULT_PATH;
  $('#gh-token').value  = ghToken();
  $('#modal').classList.remove('hidden');
}

function wireSettings() {
  $('#btn-settings').onclick = openSettings;
  $('#btn-close').onclick = () => $('#modal').classList.add('hidden');
  $('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $('#modal').classList.add('hidden');
  });

  /** Persist whatever is currently typed in the form. Returns false and
   *  says what's missing rather than letting a later call fail vaguely. */
  function saveGh({ quiet = false } = {}) {
    const owner = $('#gh-owner').value.trim();
    const repo  = $('#gh-repo').value.trim();
    const token = $('#gh-token').value.trim();
    const missing = [
      !owner && 'owner', !repo && 'repo', !token && 'token',
    ].filter(Boolean);
    if (missing.length) { toast('fill in: ' + missing.join(', '), true); return false; }

    localStorage.setItem(LS_GH, JSON.stringify({
      owner, repo,
      branch: $('#gh-branch').value.trim() || 'main',
      path:   $('#gh-path').value.trim() || DEFAULT_PATH,
    }));
    localStorage.setItem(LS_TOKEN, token);
    setSync('ok');
    if (!quiet) toast('saved — try "pull remote"');
    return true;
  }

  $('#btn-save-gh').onclick = () => saveGh();
  // pull/push save the form first, so a filled-in but unsaved form just works
  $('#btn-pull').onclick = () => { if (saveGh({ quiet: true })) pull(); };
  $('#btn-push').onclick = () => {
    if (!saveGh({ quiet: true })) return;
    push().then(ok => { if (ok) toast('pushed to ' + ghCfg().path); });
  };

  $('#btn-export').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  };
  $('#import-file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      state = merge(state, JSON.parse(await f.text()));
      saveState(); render(); toast('imported + merged');
    } catch (err) { toast('bad file: ' + err.message, true); }
  };
  $('#btn-reset').onclick = () => {
    if (!confirm('Wipe all checkboxes, notes and time logs in this browser?')) return;
    state = blank(); saveState({ sync: false }); render(); toast('reset');
  };
}

/* ── misc ──────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const PY = /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(async|await|def|class|return|if|elif|else|for|while|import|from|try|except|finally|raise|with|as|in|not|and|or|None|True|False|lambda|yield|pass|break|continue|assert|global)\b|\b(\d+\.?\d*)\b/g;

function hl(src, lang) {
  if (lang !== 'python') {
    return esc(src)
      .replace(/^(#{1,6} .*)$/gm, '<span class="k">$1</span>')
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="c">$1</span>')
      .replace(/(\*\*[^*]+\*\*)/g, '<span class="s">$1</span>');
  }
  let out = '', last = 0, m;
  PY.lastIndex = 0;
  while ((m = PY.exec(src)) !== null) {
    out += esc(src.slice(last, m.index));
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : 'n';
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(src.slice(last));
}

let toastT;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.add('hidden'), 3000);
}

/* ── boot ──────────────────────────────────────────────────────────── */

function select(id) {
  current = id;
  location.hash = id;
  renderWeek(weekById(id));
  renderSidebar();
  // only jump the viewport on mobile, where the sidebar sits above the pane
  if (window.innerWidth <= 820) $('#main').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function render() { renderSidebar(); renderHud(); if (current) renderWeek(weekById(current)); }

/** Curriculum is one file per chapter. Load the index, then every chapter
 *  in parallel, and flatten back into the shape the renderers expect. */
async function loadCurriculum() {
  const get = async p => {
    const r = await fetch(p, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${p} → ${r.status}`);
    return r.json();
  };
  const idx = await get('data/index.json');
  const chapters = await Promise.all(idx.chapters.map(id => get(`data/chapters/${id}.json`)));
  return {
    meta: idx.meta,
    principles: idx.principles,
    phases: chapters.map(c => ({
      id: c.id, name: c.name, label: c.label, goal: c.goal,
      weeks: c.weeks.map(w => w.id),
    })),
    weeks: chapters.flatMap(c => c.weeks),
  };
}

/** Repo/prompt form of the display name, e.g. "MERIDIAN" -> "meridian". */
const slug = () => (ROADMAP?.meta.title || 'meridian').toLowerCase().replace(/[^a-z0-9-]+/g, '-');

async function boot() {
  migrateKeys();
  state = loadState();
  try {
    ROADMAP = await loadCurriculum();
  } catch (e) {
    $('#main').innerHTML = `<div class="pane">
      <h1>could not load the curriculum</h1>
      <p class="dim">Opening this file directly with <code>file://</code> blocks fetch. Serve it instead:</p>
      <div class="code"><pre><code>python3 -m http.server 8000
<span class="c"># then open http://localhost:8000</span></code></pre></div>
      <p class="dim small">${esc(e.message)}</p></div>`;
    return;
  }

  // every visible instance of the name comes from meta.title
  const m = ROADMAP.meta;
  $('#brand-title').textContent  = m.title;
  $('#brand-prompt').textContent = `~/${slug()} $`;
  $('#sub').textContent = `${m.subtitle} · ${m.startDate} → ${m.endDate} · target ${m.weeklyTargetHours}h/wk`;
  document.title = `${m.title} · W${todayWeek().n}`;

  wireSettings();
  $('#btn-sync').onclick = () => ghReady() ? pull() : openSettings();
  $('#btn-jump').onclick = () => select(todayWeek().id);
  $('#hide-done').onchange = renderSidebar;

  current = (location.hash || '').replace('#', '') || todayWeek().id;
  if (!weekById(current)) current = todayWeek().id;

  renderHud();
  select(current);
  setSync(ghReady() ? 'ok' : 'local');
  if (ghReady()) pull({ quiet: true });
}

boot();
