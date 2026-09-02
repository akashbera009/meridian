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

/** Debounced autosave of one field into the notes bucket. */
function wireField(el, key, after) {
  if (!el) return;
  let t;
  el.oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => { setVal('notes', key, el.value); after?.(); }, 500);
  };
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
      el.innerHTML =
        `<span class="wk-n">${isGap(w) ? '––' : wn(w)}</span>` +
        `<span class="wk-t">${locked(w) ? '🔒 ' : ''}${esc(w.title)}` +
          `${w.milestone ? `<span class="ms" title="${esc(w.milestone)}">★</span>` : ''}</span>` +
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
  ${w.checkpoint ? `<div class="check">${esc(w.checkpoint)}
    <div class="ans-hd"><span>YOUR ANSWER · resurfaces in the tonight strip</span><span>autosaved</span></div>
    <textarea id="answer" spellcheck="false"
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

  <h3>time log · ${fmtH(minsFor(w.id))} of ${w.hours}h</h3>
  <div class="timer">
    <span class="clock" data-clock="${w.id}">00:00:00</span>
    <button class="btn" data-timerbtn="${w.id}">start</button>
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

  $('#pane').innerHTML = html;
  wireWeek(w);
}

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
    if (ans  && hit(ans, w.checkpoint)) items.push({ k: 'answer', q: w.checkpoint, v: ans });
    if (note && hit(note))              items.push({ k: 'week', v: note });
    for (const t of w.tasks || []) {
      const v = getVal('notes', t.id, '');
      if (v && hit(v, t.t)) items.push({ k: 'task', q: t.t, v });
    }
    if (items.length) rows.push({ w, items });
  }
  const n = rows.reduce((s, r) => s + r.items.length, 0);

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
        <span>${it.q ? `<div class="nb-q">${mk(it.q)}</div>` : ''}<div class="nb-v">${mk(it.v)}</div></span>
      </div>`).join('')}
    </div>`).join('')
    : `<p class="dim small">${ql ? 'no matches'
       : 'Nothing yet. The ✎ on any task, the self-check answer box and the week note all land here.'}</p>`}
</div>`;

  const q = $('#nb-q'); let t;
  q.oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const pos = q.selectionStart; nbQuery = q.value; renderNotes();
      const q2 = $('#nb-q'); q2.focus(); q2.setSelectionRange(pos, pos);
    }, 250);
  };
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
        setVal('notes', ta.dataset.tid, ta.value);
        $(`.notebtn[data-note="${ta.dataset.tid}"]`)?.classList.toggle('has', !!ta.value.trim());
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

  // shipped link + self-check answer, both keyed off the week id
  wireField($('#ship'), w.id + '.ship', () => renderShipLink(w));
  wireField($('#answer'), w.id + '.check');
  renderShipLink(w);

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
  const pc = pace(), pe = $('#hud-pace');
  pe.textContent = pc.label; pe.className = pc.cls;
  pe.title = `${pc.done.toFixed(1)}h ticked vs ${pc.expected.toFixed(1)}h expected by today`;
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

  wireSettings();
  $('#btn-sync').onclick  = () => ghReady() ? pull() : openSettings();
  $('#btn-jump').onclick  = () => select(todayWeek().id);
  $('#btn-notes').onclick = () => select('notes');
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
  setSync(ghReady() ? 'ok' : 'local');
  if (ghReady()) pull({ quiet: true });
}

boot();
