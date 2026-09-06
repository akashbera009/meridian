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

/** Carry over the old key namespace, and drop the GitHub-sync leftovers —
 *  a PAT sitting in localStorage is worth clearing now that it's unused. */
function migrateKeys() {
  const old = localStorage.getItem('aier.state');
  if (old !== null && localStorage.getItem(LS_STATE) === null) localStorage.setItem(LS_STATE, old);
  ['aier.state', 'aier.token', 'aier.gh', 'mrd.token', 'mrd.gh']
    .forEach(k => localStorage.removeItem(k));
}

let ROADMAP = null;
let state   = null;
let current = null;              // selected week id, or 'notes'
let lastWeek = null;             // week to return to when leaving the notebook
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

/** Local calendar date as YYYY-MM-DD. toISOString() is UTC, which would
 *  file a 1am IST session under the previous day. */
const localISO = (d = new Date()) => {
  const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

function todayWeek() {
  const t = localISO();
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

/* ── pace, consistency, recall ─────────────────────────────────────── */

/** Planned hours that should be done by today vs hours actually ticked,
 *  expressed in days of the plan. Gap weeks count on neither side, so the
 *  3-week park doesn't read as falling behind. */
function pace() {
  const t = localISO();
  let expected = 0, done = 0, planned = 0, days = 0;
  for (const w of weeks()) {
    if (isGap(w) || !w.tasks?.length) continue;
    const hrs  = w.tasks.reduce((s, x) => s + (x.h || 0), 0);
    const span = daysBetween(w.start, w.end) + 1;
    planned += hrs; days += span;
    done += w.tasks.filter(x => getVal('tasks', x.id, false)).reduce((s, x) => s + (x.h || 0), 0);
    if (w.end < t) expected += hrs;
    else if (w.start <= t) expected += hrs * (daysBetween(w.start, t) + 1) / span;
  }
  const rate = days ? planned / days : 1;           // planned hours per calendar day
  const dd   = (done - expected) / rate;             // +ahead / −behind, in days
  const cls  = Math.abs(dd) < 1 ? 'ok' : dd < 0 ? 'behind' : 'ahead';
  return { dd, cls, done, expected, label: cls === 'ok' ? 'on track' : `${Math.abs(dd).toFixed(1)}d ${cls}` };
}

/** Minutes logged on a local date, corrections included. */
const loggedOn = iso => state.logs
  .filter(l => localISO(l.start) === iso).reduce((s, l) => s + l.mins, 0);

/** Mon..Sun of the current calendar week — did you show up each day?
 *  Not a streak counter; just visible consistency. */
function weekDots() {
  const d = new Date(); const dow = (d.getDay() + 6) % 7;         // 0 = Mon
  const mon = new Date(d); mon.setDate(d.getDate() - dow);
  return [...Array(7)].map((_, i) => {
    const day = new Date(mon); day.setDate(mon.getDate() + i);
    const iso = localISO(day);
    return { iso, on: loggedOn(iso) > 0, today: i === dow, future: i > dow };
  });
}

/** One past self-check to re-read today. Prefers ones you've answered and
 *  rotates daily — spaced recall without a spaced-recall system. */
function recallPick() {
  const cur  = todayWeek();
  const past = weeks().filter(w => !isGap(w) && w.n < cur.n && w.checkpoint);
  if (!past.length) return null;
  const answered = past.filter(w => getVal('notes', w.id + '.check', ''));
  const pool = answered.length ? answered : past;
  return pool[Math.floor(Date.now() / 86400000) % pool.length];
}

/** Today's block of a week — or, if it's fully ticked, the next block with
 *  anything left, flagged so the strip can say you're ahead. */
function todayBlock(w) {
  const groups = byDay(w);
  const slot = todaySlot();
  const i = groups.findIndex(g => slot >= g.d && slot <= g.end);
  const open = g => g.ts.some(t => !getVal('tasks', t.id, false));
  if (i >= 0 && open(groups[i])) return { g: groups[i], ahead: false };
  const next = groups.slice(Math.max(i, 0)).find(open) || groups.find(open);
  return next ? { g: next, ahead: true } : null;
}

/** Debounced autosave of one field into the notes bucket. Also keeps the
 *  "you wrote something here" marker in step as you type. */
function wireField(el, key, after) {
  if (!el) return;
  let t;
  el.oninput = () => {
    el.classList.toggle('hasnote', !!el.value.trim());
    clearTimeout(t);
    t = setTimeout(() => { setVal('notes', key, el.value); after?.(); }, 500);
  };
}

/** Repaint the two places a note count shows, without re-rendering the
 *  pane — doing that on every keystroke would steal focus mid-sentence. */
function refreshNoteMarkers(w) {
  renderSidebar();
  const h = $('#notes-h3');
  if (!h) return;
  const n = noteCount(w);
  h.innerHTML = `notes${n ? ` · <span class="nmark">✎ ${n}</span> in this week` : ''}`;
}

/** How many notes a week holds — week note, self-check answer, task notes.
 *  Drives the sidebar marker so you can see where your thinking lives. */
function noteCount(w) {
  let n = 0;
  if (getVal('notes', w.id, '').trim()) n++;
  if (getVal('notes', w.id + '.check', '').trim()) n++;
  for (const t of w.tasks || []) if (getVal('notes', t.id, '').trim()) n++;
  return n;
}

const wn = w => 'W' + String(w.n).padStart(2, '0');

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
        + (w.milestone ? ' milestone' : '')
        + (w.id === today.id ? ' now' : '')
        + (w.id === current ? ' sel' : '');
      const nn = noteCount(w);
      el.innerHTML =
        `<span class="wk-n">${isGap(w) ? '––' : wn(w)}</span>` +
        `<span class="wk-t">${locked(w) ? '🔒 ' : ''}${esc(w.title)}` +
          `${w.milestone ? `<span class="ms" title="${esc(w.milestone)}">★</span>` : ''}` +
          `${nn ? `<span class="nmark" title="${nn} note${nn > 1 ? 's' : ''}">✎${nn > 1 ? nn : ''}</span>` : ''}</span>` +
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

/** A read-only code lab bound to a task: your own files, tabbed, collapsed
 *  by default and capped at 70vh so it never swallows the week. Deliberately
 *  NOT blue — blue means "you wrote this note"; a lab is reference. */
function renderLab(lab) {
  const open = localStorage.getItem('mrd.lab.' + lab.id) === '1';
  const i = Math.min(+(localStorage.getItem('mrd.labtab.' + lab.id) || 0), lab.tabs.length - 1);
  const tab = lab.tabs[i];
  return `
  <div class="lab${open ? ' open' : ''}" data-lab="${esc(lab.id)}">
    <div class="lab-hd">
      <span class="lab-tag">lab</span>
      <span class="lab-title">${esc(lab.title)}</span>
      <span class="lab-meta">read-only</span>
      <button class="lab-toggle">${open ? '▾ collapse' : `▸ open ${lab.tabs.length} files`}</button>
    </div>
    <div class="lab-body">
      ${lab.note ? `<p class="lab-intro">${esc(lab.note)}</p>` : ''}
      <div class="lab-tabs">
        ${lab.tabs.map((t, n) => `<button class="lab-tab${n === i ? ' on' : ''}" data-i="${n}">
          ${esc(t.name)}<span class="lab-file">${esc(t.file)}</span></button>`).join('')}
      </div>
      <div class="lab-pane">${labPane(tab)}</div>
    </div>
  </div>`;
}

const labPane = tab => `
  ${tab.note ? `<p class="lab-note">${esc(tab.note)}</p>` : ''}
  <div class="code lab-code">
    <div class="code-hd"><span>${esc(tab.file)}</span>
      <button class="btn btn-sm lab-copy">copy</button></div>
    <pre><code>${hl(tab.body, tab.lang)}</code></pre>
  </div>`;

/** A measured-results table sitting under the deliverable: the numbers you
 *  actually got, so the week ends in evidence rather than a screenshot you
 *  cannot attach. Collapsed by default; the rows are fixed, the reading is
 *  yours to write. */
function renderBench(w) {
  const b = w.bench;
  if (!b) return '';
  const key  = w.id + '.bench';
  const note = getVal('notes', key, b.reading || '');
  const open = localStorage.getItem('mrd.bench.' + w.id) === '1';
  const cell = (v, best) =>
    `<td class="${best ? 'bn-win' : ''}">${esc(v == null ? '—' : String(v))}</td>`;

  return `
  <div class="bench${open ? ' open' : ''}" data-bench="${esc(w.id)}">
    <div class="bench-hd">
      <span class="bench-tag">data</span>
      <span class="bench-title">${esc(b.title || 'see comparison')}</span>
      <button class="bench-toggle">${open ? '▾ hide' : '▸ see comparison'}</button>
    </div>
    <div class="bench-body">
      ${b.note ? `<p class="bench-intro">${esc(b.note)}</p>` : ''}
      <div class="bench-scroll">
      <table class="bench-tbl">
        <thead><tr><th>${esc(b.metricLabel || 'metric')}</th>
          ${b.cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>
          ${b.rows.map(r => `<tr>
            <th>${esc(r.m)}${r.hint ? `<span class="bn-hint">${esc(r.hint)}</span>` : ''}</th>
            ${r.v.map((v, i) => cell(v, r.best === i)).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
      </div>
      ${b.raw ? `
      <div class="bench-raw">
        <div class="bench-rawhd">
          <span>${esc(b.raw.title || 'raw · every call')}</span>
          <button class="btn btn-sm bench-rawtog">▸ show all ${b.raw.rows.length}</button>
        </div>
        ${b.raw.note ? `<p class="bench-intro">${esc(b.raw.note)}</p>` : ''}
        <div class="bench-scroll">
        <table class="bench-tbl bench-rawtbl">
          <thead><tr><th>#</th>${b.raw.cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>
            ${b.raw.rows.map((r, i) => `<tr class="${i >= 10 ? 'bn-more' : ''}">
              <th>${i + 1}</th>${r.map(v => `<td>${esc(v == null ? '—' : String(v))}</td>`).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
        </div>
      </div>` : ''}
      ${b.verdict ? `<p class="bench-verdict">${esc(b.verdict)}</p>` : ''}
      <div class="ans-hd"><span>WHAT THE NUMBERS MEAN · your reading</span><span>autosaved</span></div>
      <textarea class="bench-note${note.trim() ? ' hasnote' : ''}" data-benchnote="${esc(key)}"
        spellcheck="false" placeholder="why did it come out this way? what would you change?">${esc(note)}</textarea>
    </div>
  </div>`;
}

/** Toggle, tab-switch and copy. Tabs swap the pane in place rather than
 *  re-rendering the week, so your scroll position survives. */
function wireLabs(w) {
  $$('.lab').forEach(el => {
    const id = el.dataset.lab;
    const lab = (w.labs || []).find(l => l.id === id);
    if (!lab) return;

    const copy = () => {
      const c = el.querySelector('.lab-copy');
      if (!c) return;
      c.onclick = async () => {
        const n = +(localStorage.getItem('mrd.labtab.' + id) || 0);
        await navigator.clipboard.writeText(lab.tabs[Math.min(n, lab.tabs.length - 1)].body);
        c.textContent = 'copied'; setTimeout(() => c.textContent = 'copy', 1200);
      };
    };
    copy();

    const tog = el.querySelector('.lab-toggle');
    // the whole header is the hit target, not just the small button
    el.querySelector('.lab-hd').onclick = () => {
      const open = el.classList.toggle('open');
      localStorage.setItem('mrd.lab.' + id, open ? '1' : '0');
      tog.textContent = open ? '▾ collapse' : `▸ open ${lab.tabs.length} files`;
    };

    el.querySelectorAll('.lab-tab').forEach(b => b.onclick = () => {
      const n = +b.dataset.i;
      localStorage.setItem('mrd.labtab.' + id, n);
      el.querySelectorAll('.lab-tab').forEach(x => x.classList.toggle('on', x === b));
      el.querySelector('.lab-pane').innerHTML = labPane(lab.tabs[n]);
      el.querySelector('.lab-body').scrollTop = 0;
      copy();
    });
  });
}

/** One task, plus the resources bound to it and its own note box. */
function taskRow(w, t) {
  const done = getVal('tasks', t.id, false);
  const note = getVal('notes', t.id, '');
  const res  = (w.resources || []).filter(r => r.task === t.id);
  const noted = !!note.trim();
  const labs = (w.labs || []).filter(l => l.task === t.id);
  return `
  <div class="task ${done ? 'done' : ''}${noted ? ' noted' : ''}" data-tid="${t.id}">
    <input type="checkbox" id="${t.id}" ${done ? 'checked' : ''}>
    <label for="${t.id}">${esc(t.t)}</label>
    <span class="h">${t.h ? t.h + 'h' : ''}</span>
    <button class="notebtn${note ? ' has' : ''}" data-note="${t.id}"
            title="${note ? 'edit note' : 'add note'}">✎</button>
  </div>
  <div class="task-sub${noted ? ' noted' : ''}${res.length || note || labs.length ? '' : ' bare'}" data-subfor="${t.id}">
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
    ${labs.map(renderLab).join('')}
    <div class="note-wrap${note ? '' : ' hidden'}" data-notefor="${t.id}">
      <textarea class="tnote" data-tid="${t.id}" spellcheck="false"
        placeholder="what broke · the number you got · what you'd do differently">${esc(note)}</textarea>
      <button class="expand sm" data-key="${t.id}" data-t="${esc(wn(w) + ' · ' + t.t.slice(0, 46))}"
              title="Open in the full editor">⤢ expand</button>
    </div>
  </div>`;
}

function renderWeek(w) {
  const today = todayWeek();
  const p = pct(w);
  const tags = [
    w.id === today.id ? '<span class="tag now">◀ current</span>' : '',
    isGap(w) ? '<span class="tag gap">parked</span>' : '',
    w.milestone ? `<span class="tag ms">★ ${esc(w.milestone)}</span>` : '',
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

  ${w.deliverable ? `<div class="deliv">${esc(w.deliverable)}
    <input id="ship" placeholder="link to what you shipped — repo, commit, screenshot, live URL"
           value="${esc(getVal('notes', w.id + '.ship', ''))}">
    <span class="ship-link" id="ship-link"></span></div>` : ''}
  ${renderBench(w)}
  ${w.checkpoint ? `<div class="check">${esc(w.checkpoint)}
    <div class="ans-hd"><span>YOUR ANSWER · resurfaces in the tonight strip</span><span>autosaved</span></div>
    <textarea id="answer" spellcheck="false" class="${getVal('notes', w.id + '.check', '').trim() ? 'hasnote' : ''}"
      placeholder="answer in your own words, as if to an interviewer">${esc(getVal('notes', w.id + '.check', ''))}</textarea></div>` : ''}

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

  <div id="timecard">
    <h3>time log · <span id="tl-sum">${fmtH(minsFor(w.id))} of ${w.hours}h</span></h3>
    <div class="timer">
      <span class="clock" data-clock="${w.id}">00:00:00</span>
      <button class="btn" data-timerbtn="${w.id}">start</button>
      <div class="timer-man">
        <input type="number" id="man-mins" min="-900" max="900" step="5" placeholder="±min">
        <button class="btn" id="btn-add-log">log</button>
      </div>
      <span class="dim small">negative subtracts — use it to correct an over-log</span>
    </div>
    <div class="hbar"><i id="hbar" style="width:0"></i></div>
    <div class="logs" id="logs"></div>
  </div>

  <h3 id="notes-h3">notes${noteCount(w) ? ` · <span class="nmark">✎ ${noteCount(w)}</span> in this week` : ''}</h3>
  <div class="notes-hd">
    <span class="dim small">markdown, autosaved</span>
    <span><span class="saved hidden" id="saved">saved ✓</span>
      <button class="expand sm" data-key="${w.id}" data-t="${esc(wn(w) + ' · week note')}"
              title="Open in the full editor">⤢ expand</button></span>
  </div>
  <textarea id="notes" spellcheck="false" class="${getVal('notes', w.id, '').trim() ? 'hasnote' : ''}"
    placeholder="$ what clicked, what broke, links, numbers…">${esc(getVal('notes', w.id, ''))}</textarea>

  <div class="rule" style="margin-top:26px">${'─'.repeat(120)}</div>
  <div class="row">
    ${w.n > 0 ? `<button class="btn" id="btn-prev">‹ prev</button>` : ''}
    <button class="btn" id="btn-next">next ›</button>
  </div>
</div>`;

  // the docked card lives outside #pane, so replacing the pane alone would
  // leave the previous week's timer (and its clock) stranded in the rail
  clearRail();
  $('#pane').innerHTML = html;
  wireWeek(w);
  dockTimer();
}

/* ── timer docking ──────────────────────────────────────────────────
   The timer is the one control you reach for mid-session, so on a wide
   screen it moves into the right rail and stays put while you scroll
   the week. Narrow screens keep it inline, where the pane already
   reads top-to-bottom. Moving the node (rather than rendering twice)
   keeps the running clock and its listeners intact. */
const WIDE = window.matchMedia('(min-width:1200px)');

/** Views without a timer (the notebook, the load error) must empty the rail
 *  themselves — the timecard lives outside #pane when docked, so replacing
 *  the pane alone would strand a stale week's clock on screen. */
const clearRail = () => { const r = $('#rail'); if (r) r.innerHTML = ''; };

function dockTimer() {
  const card = $('#timecard'), rail = $('#rail'), pane = $('#pane');
  if (!card || !rail || !pane) return;
  const wide = WIDE.matches;
  if (wide) {
    if (card.parentElement !== rail) rail.appendChild(card);
  } else {
    // back to its inline slot: just before the notes heading. That heading
    // sits inside .pane, not #pane, so insert relative to its real parent.
    const anchor = pane.querySelector('#notes-h3');
    const host = anchor ? anchor.parentElement : (pane.querySelector('.pane') || pane);
    if (card.parentElement !== host) {
      anchor ? host.insertBefore(card, anchor) : host.appendChild(card);
    }
  }
  card.classList.toggle('docked', wide);
}

WIDE.addEventListener('change', dockTimer);

/* ── tonight strip ──────────────────────────────────────────────────── */

function renderTonight() {
  const box = $('#tonight'); if (!box) return;
  const w = todayWeek();
  const collapsed = localStorage.getItem('mrd.tn') === '0';
  const dateStr = new Date().toLocaleDateString('en-GB',
    { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase();
  const dots = weekDots().map(x => `<span class="dot${x.on ? ' on' : ''}${x.today ? ' today' : ''}${x.future ? ' future' : ''}"
    title="${x.iso}${x.on ? ' · ' + fmtH(loggedOn(x.iso)) : ''}"></span>`).join('');

  let body;
  if (isGap(w)) {
    body = `<div class="tn-empty">parked — nothing scheduled this week. ${w.n === 12
      ? 'The re-entry ramp is in the pane below.' : 'Protect the pause; it is part of the plan.'}</div>`;
  } else {
    const blk = todayBlock(w);
    if (!blk) {
      body = `<div class="tn-empty">✓ every task this week is ticked. Write the week note, then rest.</div>`;
    } else {
      const { g, ahead } = blk;
      const planned = g.ts.reduce((s, t) => s + (t.h || 0), 0);
      body = `
        ${ahead ? `<span class="tn-next">today's block is done — next up · ${esc(g.label)}</span>` : ''}
        ${g.ts.map(t => `
        <div class="task ${getVal('tasks', t.id, false) ? 'done' : ''}">
          <input type="checkbox" class="tn-chk" data-tid="${t.id}" ${getVal('tasks', t.id, false) ? 'checked' : ''}>
          <label>${esc(t.t)}</label>
          <span class="h">${t.h ? t.h + 'h' : ''}</span><span></span>
        </div>`).join('')}
        <div class="tn-foot">
          <span class="clock" data-clock="${w.id}">00:00:00</span>
          <button class="btn btn-sm" data-timerbtn="${w.id}">start</button>
          <span>${round1(planned)}h planned · ${fmtH(loggedOn(localISO()))} logged today</span>
          <a class="tn-go" href="#${w.id}">open week ›</a>
        </div>`;
    }
  }

  const rc = recallPick();
  const ans = rc ? getVal('notes', rc.id + '.check', '') : '';
  const recall = rc ? `
    <div class="recall">
      <span class="rc-tag">$ recall --from ${rc.id}</span>
      <div class="rc-q">${esc(rc.checkpoint)}</div>
      ${ans
        ? `<button class="btn btn-sm" id="rc-reveal">show my answer</button><div class="rc-a hidden" id="rc-a">${esc(ans)}</div>`
        : `<span class="dim small">unanswered — <a href="#${rc.id}">write one</a> and it comes back here</span>`}
    </div>`
    : `<div class="recall"><span class="rc-tag">$ recall</span>
       <div class="rc-q dim">from week 1, a past self-check resurfaces here each day — spaced recall</div></div>`;

  box.innerHTML = `
  <div class="tonight${collapsed ? ' collapsed' : ''}">
    <div class="tn-head">
      <span class="prompt">$ tonight</span>
      <span class="tn-meta">${dateStr} · ${isGap(w) ? 'PARKED' : wn(w)} <b>${esc(w.title)}</b></span>
      <span class="dots" title="days you logged time this week">${dots}</span>
      <button class="btn btn-sm" id="tn-toggle">${collapsed ? 'expand' : 'collapse'}</button>
    </div>
    <div class="tn-body">${body}${recall}</div>
  </div>`;

  $('#tn-toggle').onclick = () => { localStorage.setItem('mrd.tn', collapsed ? '1' : '0'); renderTonight(); };
  $$('.tn-chk').forEach(cb => cb.onchange = () => {
    setVal('tasks', cb.dataset.tid, cb.checked);
    if (current === w.id) renderWeek(w);            // keep the pane's copy honest
    renderSidebar(); renderHud(); renderTonight();
  });
  const rv = $('#rc-reveal');
  if (rv) rv.onclick = () => { $('#rc-a').classList.remove('hidden'); rv.remove(); };
  startClock();
}

/* ── notebook: every note, answer and shipped link, searchable ──────── */

let nbQuery = '';

function renderNotes() {
  const ql  = nbQuery.trim().toLowerCase();
  const hit = (...ss) => !ql || ss.some(s => (s || '').toLowerCase().includes(ql));
  const re  = ql ? new RegExp(ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
  const mk  = s => re ? esc(s).replace(re, m => `<mark>${m}</mark>`) : esc(s);

  const ships = [], rows = [];
  for (const w of weeks()) {
    const ship = getVal('notes', w.id + '.ship', '').trim();
    const ans  = getVal('notes', w.id + '.check', '');
    const note = getVal('notes', w.id, '');
    if (ship) ships.push({ w, ship });
    const items = [];
    if (ans  && hit(ans, w.checkpoint)) items.push({ k: 'answer', q: w.checkpoint, v: ans, key: w.id + '.check', t: `${wn(w)} · self-check` });
    if (note && hit(note))              items.push({ k: 'week', v: note, key: w.id, t: `${wn(w)} · week note` });
    for (const t of w.tasks || []) {
      const v = getVal('notes', t.id, '');
      if (v && hit(v, t.t)) items.push({ k: 'task', q: t.t, v, key: t.id, t: `${wn(w)} · ${t.t.slice(0, 46)}…` });
    }
    if (items.length) rows.push({ w, items });
  }
  const n = rows.reduce((s, r) => s + r.items.length, 0);

  clearRail();
  $('#pane').innerHTML = `
<div class="pane">
  <div class="rule">${'─'.repeat(120)}</div>
  <div class="wk-head"><h1>notebook</h1></div>
  <input class="nb-search" id="nb-q" value="${esc(nbQuery)}"
         placeholder="$ grep -i …   searches notes, answers and task text">

  <h3>ship log · ${ships.length} linked</h3>
  ${ships.length ? ships.map(({ w, ship }) => `
    <div class="ship-row">
      <span class="wn">${wn(w)}</span>
      <span><a href="${esc(ship)}" target="_blank" rel="noopener">${esc(ship.replace(/^https?:\/\//, ''))}</a>
        <span class="dl">${esc(w.deliverable)}</span></span>
    </div>`).join('')
    : `<p class="dim small">Nothing linked yet. Every week's deliverable has a link field — paste the repo,
       commit or screenshot there and this list becomes your portfolio index.</p>`}

  <h3>notes · ${n} entr${n === 1 ? 'y' : 'ies'}${ql ? ` matching "${esc(nbQuery)}"` : ''}</h3>
  ${rows.length ? rows.map(({ w, items }) => `
    <div class="nb-week">
      <h4><a href="#${w.id}">${wn(w)} · ${esc(w.title)}</a></h4>
      ${items.map(it => `
      <div class="nb-item">
        <span class="nb-k ${it.k}">${it.k}</span>
        <span>${it.q ? `<div class="nb-q">${mk(it.q)}</div>` : ''}
          <div class="nb-v">${ql ? mk(it.v) : md(it.v)}</div></span>
        <button class="expand" data-key="${esc(it.key)}" data-t="${esc(it.t)}" title="Open in editor">⤢</button>
      </div>`).join('')}
    </div>`).join('')
    : `<p class="dim small">${ql ? 'no matches'
       : 'Nothing yet. The ✎ on any task, the self-check answer box and the week note all land here.'}</p>`}

  <h3>data</h3>
  <p class="dim small">Progress lives in this browser and, when you're signed in, in your private
    Firestore document. Export is a plain JSON file you can keep or move to another browser.</p>
  <div class="row">
    <button class="btn" id="btn-export">export json</button>
    <label class="btn" for="import-file">import json</label>
    <input type="file" id="import-file" accept=".json" hidden>
    <button class="btn btn-danger" id="btn-reset">reset all progress</button>
  </div>
</div>`;

  const q = $('#nb-q'); let t;
  q.oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const pos = q.selectionStart; nbQuery = q.value; renderNotes();
      const q2 = $('#nb-q'); q2.focus(); q2.setSelectionRange(pos, pos);
    }, 250);
  };
  $$('.expand').forEach(b => b.onclick = () =>
    openEditor(b.dataset.key, b.dataset.t, renderNotes));
  wireDataActions();
}

function renderShipLink(w) {
  const el = $('#ship-link'); if (!el) return;
  const v = getVal('notes', w.id + '.ship', '').trim();
  el.innerHTML = /^https?:\/\//i.test(v)
    ? `<a href="${esc(v)}" target="_blank" rel="noopener">↗ ${esc(v.replace(/^https?:\/\//, ''))}</a>` : '';
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
        const id = ta.dataset.tid, has = !!ta.value.trim();
        setVal('notes', id, ta.value);
        $(`.notebtn[data-note="${id}"]`)?.classList.toggle('has', has);
        $(`.task[data-tid="${id}"]`)?.classList.toggle('noted', has);
        $(`.task-sub[data-subfor="${id}"]`)?.classList.toggle('noted', has);
        refreshNoteMarkers(w);
      }, 500);
    };
  });

  $$('#tasks .task input').forEach(cb => cb.onchange = () => {
    const next = weeks().find(x => x.n > w.n && !isGap(x));
    const wasLocked = next ? locked(next) : false;
    setVal('tasks', cb.id, cb.checked);
    cb.closest('.task').classList.toggle('done', cb.checked);
    $('#tasks').previousElementSibling.textContent =
      `plan · ${w.tasks.filter(t => getVal('tasks', t.id, false)).length}/${w.tasks.length} · ${pct(w)}%`;
    // small rewards at the two moments that matter
    if (cb.checked && !isGap(w) && pct(w) === 100)
      toast(`${wn(w)} complete — write the one-line takeaway in the week note`);
    else if (next && wasLocked && !locked(next))
      toast(`${wn(next)} unlocked`);
    renderSidebar(); renderHud(); renderTonight();
  });

  const nb = $('#notes'); let nt;
  nb.oninput = () => {
    nb.classList.toggle('hasnote', !!nb.value.trim());
    clearTimeout(nt);
    nt = setTimeout(() => {
      setVal('notes', w.id, nb.value);
      const s = $('#saved'); s.classList.remove('hidden');
      setTimeout(() => s.classList.add('hidden'), 1200);
      refreshNoteMarkers(w);
    }, 500);
  };

  $$('.copy').forEach(b => b.onclick = async () => {
    await navigator.clipboard.writeText(w.code[+b.dataset.i].body);
    b.textContent = 'copied'; setTimeout(() => b.textContent = 'copy', 1200);
  });

  wireLabs(w);

  $$('.expand').forEach(b => b.onclick = () =>
    openEditor(b.dataset.key, b.dataset.t, () => renderWeek(w)));

  const unlock = $('#btn-unlock');
  if (unlock) unlock.onclick = () => { setVal('unlocked', w.id, true); select(w.id); renderSidebar(); };

  // shipped link + self-check answer, both keyed off the week id
  wireField($('#ship'), w.id + '.ship', () => renderShipLink(w));
  wireField($('#answer'), w.id + '.check', () => refreshNoteMarkers(w));
  renderShipLink(w);

  // benchmark table: collapse state is local-only, the reading syncs like a note
  const bench = $('.bench');
  if (bench) {
    const tog = bench.querySelector('.bench-toggle');
    bench.querySelector('.bench-hd').onclick = () => {
      const on = bench.classList.toggle('open');
      localStorage.setItem('mrd.bench.' + w.id, on ? '1' : '0');
      tog.textContent = on ? '▾ hide' : '▸ see comparison';
    };
    // raw rows past the first 10 stay folded until asked for
    const raw = bench.querySelector('.bench-raw');
    if (raw) {
      const rt = raw.querySelector('.bench-rawtog');
      const n  = raw.querySelectorAll('.bn-more').length;
      rt.onclick = e => {
        e.stopPropagation();            // don't collapse the whole block
        const on = raw.classList.toggle('all');
        rt.textContent = on ? '▾ show first 10' : `▸ show all ${n + 10}`;
      };
    }

    const bn = bench.querySelector('.bench-note');
    if (bn) wireField(bn, bn.dataset.benchnote, () => refreshNoteMarkers(w));
  }

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
  renderLogs(weekById(weekId)); startClock(); renderTonight();
}

function addLog(weekId, start, mins) {
  // random suffix so two entries in the same millisecond can't collide on sync
  const id = `${weekId}-${start}-${Math.random().toString(36).slice(2, 7)}`;
  state.logs.push({ id, week: weekId, start, mins });
  saveState();
  renderLogs(weekById(weekId)); renderHud(); renderTonight();
}

/** Paints every clock / start-stop button on the page for whichever week
 *  it's bound to — the strip and the pane can both show one. */
function startClock() {
  clearInterval(tick);
  const paint = () => {
    $$('[data-clock]').forEach(el => {
      const run = state.timer && state.timer.week === el.dataset.clock;
      const s = run ? Math.floor((now() - state.timer.startedAt) / 1000) : 0;
      el.textContent = [s / 3600, (s % 3600) / 60, s % 60]
        .map(x => String(Math.floor(x)).padStart(2, '0')).join(':');
      el.classList.toggle('run', !!run);
    });
    $$('[data-timerbtn]').forEach(b => {
      const run = state.timer && state.timer.week === b.dataset.timerbtn;
      b.textContent = run ? 'stop' : 'start';
      b.classList.toggle('on', !!run);
    });
  };
  paint();
  if (state.timer) tick = setInterval(paint, 1000);
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
  const sum = $('#tl-sum');
  if (sum) sum.textContent = `${fmtH(minsFor(w.id))} of ${w.hours}h`;
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
  const pc = pace(), pe = $('#hud-pace');
  pe.textContent = pc.label; pe.className = pc.cls;
  pe.title = `${pc.done.toFixed(1)}h ticked vs ${pc.expected.toFixed(1)}h expected by today`;
}

/* ── firestore sync ────────────────────────────────────────────────── */

let uid = null;          // null until signed in
let unwatch = null;      // detach the live listener on sign-out

const syncOn = () => !!(uid && window.FB);

const setSync = s => {
  const e = $('#sync-label'); if (!e) return;
  e.textContent = s;
  $('#btn-account')?.classList.toggle('on', s === 'synced' || s === '•' || s === '…');
};

/** Pull once and merge. Runs on sign-in, and behind the ⇅ button. */
async function pull({ quiet = false } = {}) {
  if (!syncOn()) return quiet || toast('sign in first (⚙)', true);
  try {
    setSync('…');
    const remote = await window.FB.load(uid);
    if (remote) { state = merge(state, remote); saveState({ sync: false }); render(); }
    setSync('sync');
    if (!quiet) toast(remote ? 'pulled + merged' : 'nothing saved yet — this device is the first');
  } catch (e) { setSync('err'); toast(explain(e), true); }
}

/** Merge-then-write, so a device that was offline can't clobber the others. */
async function push() {
  if (!syncOn()) return false;
  try {
    setSync('…');
    const remote = await window.FB.load(uid);
    if (remote) state = merge(state, remote);
    const { timer, ...clean } = state;          // timer is device-local, never synced
    await window.FB.save(uid, clean);
    saveState({ sync: false });
    setSync('sync');
    return true;
  } catch (e) { setSync('err'); toast(explain(e), true); return false; }
}

function explain(e) {
  const c = String(e?.code || e?.message || e);
  if (c.includes('permission-denied')) return 'permission denied — check the Firestore rules';
  if (c.includes('unavailable') || c.includes('network')) return 'offline — saved locally, will retry';
  if (c.includes('popup-blocked')) return 'popup blocked — allow popups, or try again';
  if (c.includes('unauthorized-domain')) return 'this domain is not authorized in Firebase Auth';
  return 'sync failed: ' + c.slice(0, 120);
}

function schedulePush() {
  if (!syncOn()) return;
  clearTimeout(pushTimer);
  setSync('•');
  pushTimer = setTimeout(push, 3000);   // debounce: don't write on every keystroke
}

/** Wire auth once Firebase has loaded. Signed in: pull, then listen for
 *  changes from your other devices. Signed out: local only, nothing lost. */
function initSync() {
  if (!window.FB) return;
  window.FB.onAuth(async user => {
    unwatch?.(); unwatch = null;
    uid = user?.uid || null;
    renderAccount();
    if (!uid) { setSync('local'); return; }
    await pull({ quiet: true });
    await push();                                    // seed the doc on first sign-in
    unwatch = window.FB.watch(uid, remote => {       // live: another device wrote
      const before = JSON.stringify(state);
      state = merge(state, remote);
      if (JSON.stringify(state) !== before) { saveState({ sync: false }); render(); }
    });
  });
}

/** Header account button. Signed out it signs you in; signed in it shows
 *  who you are and offers to sign out. Sync itself needs no button. */
function renderAccount() {
  const b = $('#btn-account'); if (!b) return;
  const u = window.FB?.user();
  if (u) {
    // show who, without putting a full email in the header
    const who = (u.email || '').split('@')[0] || u.displayName || u.uid.slice(0, 6);
    setSync('synced ' + who);
    b.title = `Synced as ${u.email || u.uid} — click to sign out`;
    b.onclick = async () => {
      if (!confirm(`Signed in as ${u.email || u.uid}.\n\nSign out? This browser keeps its own copy.`)) return;
      await window.FB.signOut();
      toast('signed out — this browser keeps its own copy');
    };
  } else {
    b.title = window.FB ? 'Sign in to sync across your devices' : 'Loading…';
    b.onclick = async () => {
      if (!window.FB) return toast('still loading — try again in a second', true);
      try { await window.FB.signIn(); } catch (e) { toast(explain(e), true); }
    };
    setSync('local');
  }
}

/* ── markdown ──────────────────────────────────────────────────────── */

/** Small block-level markdown renderer. Input is escaped first, so nothing
 *  a note contains can inject markup. Code spans and fences are stashed
 *  before inline rules run, so `**` inside code stays literal. */
function md(src) {
  const stash = [];
  const keep = html => ` ${stash.push(html) - 1} `;
  let s = esc(src || '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, c) => keep(`<pre class="mdcode">${c.replace(/\n+$/, '')}</pre>`))
    .replace(/`([^`\n]+)`/g, (_, c) => keep(`<code class="mdi">${c}</code>`));

  const inline = t => t
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

  const out = []; let list = null, para = [];
  const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
  const flushL = () => {
    if (!list) return;
    out.push(`<${list.t}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.t}>`);
    list = null;
  };

  for (const line of s.split('\n')) {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    const bq = line.match(/^&gt;\s?(.*)$/);
    if (h)       { flushP(); flushL(); const n = Math.min(6, h[1].length + 2); out.push(`<h${n} class="mdh">${inline(h[2])}</h${n}>`); }
    else if (ul) { flushP(); if (list?.t !== 'ul') { flushL(); list = { t: 'ul', items: [] }; } list.items.push(ul[1]); }
    else if (ol) { flushP(); if (list?.t !== 'ol') { flushL(); list = { t: 'ol', items: [] }; } list.items.push(ol[1]); }
    else if (bq) { flushP(); flushL(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); }
    else if (!line.trim())                    { flushP(); flushL(); }
    else if (/^ \d+ $/.test(line.trim())) { flushP(); flushL(); out.push(line.trim()); }
    else para.push(line);
  }
  flushP(); flushL();
  return out.join('').replace(/ (\d+) /g, (_, i) => stash[+i]);
}

/* ── full-screen note editor ───────────────────────────────────────── */

let edKey = null, edSaveT = null, edAfter = null;

/** Open the big editor on any note key. `after` re-renders whatever view
 *  the note came from, so the blue rail and previews stay in step. */
function openEditor(key, title, after) {
  edKey = key; edAfter = after || null;
  const ta = $('#ed-text');
  $('#ed-title').textContent = title;
  ta.value = getVal('notes', key, '');
  $('#editor').classList.remove('hidden');
  edPaint();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function closeEditor() {
  if (!edKey) return;
  clearTimeout(edSaveT); edSave();
  $('#editor').classList.add('hidden');
  const after = edAfter; edKey = null; edAfter = null;
  after?.();
}

function edSave() {
  if (!edKey) return;
  setVal('notes', edKey, $('#ed-text').value);
  $('#ed-status').textContent = 'saved ✓';
  setTimeout(() => { if (edKey) $('#ed-status').textContent = 'autosaved'; }, 1200);
}

function edPaint() {
  const v = $('#ed-text').value;
  $('#ed-prev').innerHTML = md(v);
  const words = v.trim() ? v.trim().split(/\s+/).length : 0;
  $('#ed-count').textContent = `${words} word${words === 1 ? '' : 's'} · ${v.length} chars`;
}

/** Wrap the selection in `a|b`, or prefix each selected line. */
function edApply({ wrap, prefix, link }) {
  const ta = $('#ed-text');
  const [s, e] = [ta.selectionStart, ta.selectionEnd];
  const sel = ta.value.slice(s, e);
  let text, caret;
  if (link) {
    const url = prompt('Link URL', 'https://');
    if (!url) return;
    text = `[${sel || 'text'}](${url})`; caret = s + text.length;
  } else if (wrap) {
    const [a, b] = wrap.replace(/\\n/g, '\n').split('|');
    text = a + sel + b; caret = sel ? s + text.length : s + a.length;
  } else {
    const lines = (sel || '').split('\n');
    text = lines.map(l => prefix + l).join('\n'); caret = s + text.length;
  }
  ta.setRangeText(text, s, e, 'end');
  ta.selectionStart = ta.selectionEnd = caret;
  ta.focus(); edPaint();
  clearTimeout(edSaveT); edSaveT = setTimeout(edSave, 400);
}

function wireEditor() {
  const ta = $('#ed-text');
  $('#ed-close').onclick = closeEditor;
  $('#editor').onclick = e => { if (e.target.id === 'editor') closeEditor(); };
  $('#ed-split').onclick = () => {
    const on = $('#ed-body').classList.toggle('split');
    $('#ed-split').classList.toggle('on', on);
    localStorage.setItem('mrd.split', on ? '1' : '0');
    edPaint();
  };
  if (localStorage.getItem('mrd.split') === '1') {
    $('#ed-body').classList.add('split'); $('#ed-split').classList.add('on');
  }
  $$('#ed-tools .tb').forEach(b => b.onclick = () =>
    edApply({ wrap: b.dataset.w, prefix: b.dataset.p, link: b.dataset.link }));

  ta.oninput = () => { edPaint(); clearTimeout(edSaveT); edSaveT = setTimeout(edSave, 400); };
  ta.onkeydown = e => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 'b') { e.preventDefault(); edApply({ wrap: '**|**' }); }
    if (meta && e.key === 'i') { e.preventDefault(); edApply({ wrap: '*|*' }); }
    if (meta && e.key === 'k') { e.preventDefault(); edApply({ link: 1 }); }
    if (meta && e.key === 'Enter') { e.preventDefault(); closeEditor(); }
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && edKey) closeEditor(); });
}

/* ── data actions (now on the notebook page) ───────────────────────── */

/** These controls live at the bottom of the notebook, so they're re-wired
 *  each time that view renders. */
function wireDataActions() {
  const ex = $('#btn-export'); if (!ex) return;
  ex.onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `meridian-${new Date().toISOString().slice(0, 10)}.json`;
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
    if (!confirm('Wipe all checkboxes, notes and time logs in this browser?\n\nIf you are signed in, this also syncs the wipe to your other devices.')) return;
    state = blank(); saveState(); render(); toast('reset');
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
  if (id !== 'notes') lastWeek = id;
  $('#btn-notes')?.classList.toggle('on', id === 'notes');
  if (id === 'notes') renderNotes(); else renderWeek(weekById(id));
  renderSidebar();
  $('.wk.sel')?.scrollIntoView({ block: 'nearest' });     // sidebar follows you
  if (window.innerWidth <= 820) {
    $('#sidebar').classList.add('collapsed');
    $('#main').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function render() {
  renderSidebar(); renderHud(); renderTonight();
  if (current === 'notes') renderNotes(); else if (current) renderWeek(weekById(current));
}

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
    clearRail();
    $('#pane').innerHTML = `<div class="pane">
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

  wireEditor();
  renderAccount();
  // Firebase is a module, so it may resolve before or after this runs
  if (window.FB) initSync();
  else window.addEventListener('fb-ready', () => { renderAccount(); initSync(); }, { once: true });
  $('#btn-jump').onclick  = () => select(todayWeek().id);
  // toggle: open the notebook, or click again to go back to where you were
  $('#btn-notes').onclick = () => select(current === 'notes' ? (lastWeek || todayWeek().id) : 'notes');
  $('#btn-weeks').onclick = () => $('#sidebar').classList.toggle('collapsed');
  $('#hide-done').onchange = renderSidebar;

  // one listener covers every start/stop button, wherever it renders
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-timerbtn]');
    if (b) toggleTimer(b.dataset.timerbtn);
  });
  // #w05 / #notes links inside the strip and notebook navigate in place
  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (id && id !== current && (id === 'notes' || weekById(id))) select(id);
  });
  if (window.innerWidth <= 820) $('#sidebar').classList.add('collapsed');

  current = (location.hash || '').replace('#', '') || todayWeek().id;
  if (current !== 'notes' && !weekById(current)) current = todayWeek().id;

  renderHud();
  renderTonight();
  select(current);
  setSync('local');
}

boot();
