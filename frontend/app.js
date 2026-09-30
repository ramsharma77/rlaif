'use strict';
/* Harness Optimization Engine — single-page frontend (vanilla JS, hash routing). */

const S = { agent: 'billing', boot: null, timers: [], query: new URLSearchParams(), jobs: {}, health: null, healthTimer: null };
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v, d = 1) => v == null ? '—' : (v * 100).toFixed(d) + '%';
const pts = (v, d = 1) => v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(d) + ' pts';
const num = v => v == null ? '—' : Math.round(v).toLocaleString('en-US');
const fx = (v, d = 2) => v == null ? '—' : Number(v).toFixed(d);
const sign = (v, d = 0) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);
const cls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
const fmtTs = v => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return esc(String(v));
  return d.toLocaleString();
};

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

let toastTimer;
function toast(msg, err = false) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), err ? 6000 : 3200);
}

let ACT = {};
document.addEventListener('click', e => {
  const nav = e.target.closest('[data-href]');
  if (nav && !e.target.closest('a,button,select,input')) { location.hash = nav.dataset.href; return; }
  const el = e.target.closest('[data-act]');
  if (el && ACT[el.dataset.act]) { e.preventDefault(); ACT[el.dataset.act](el, e); }
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (el && ACT[el.dataset.change]) ACT[el.dataset.change](el, e);
});

async function busy(btn, fn) {
  if (!btn) return fn();
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${esc(btn.dataset.busy || 'Working…')}`;
  try { return await fn(); } catch (e) { toast(e.message, true); }
  finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = html; } }
}

const page = html => { $('#main').innerHTML = html; };
function crumbs(items) {
  $('#crumbs').innerHTML = items.map(([l, h]) => h ? `<a href="${h}">${esc(l)}</a>` : `<span>${esc(l)}</span>`).join(' <span class="faint">/</span> ');
}
function head(title, sub = '', actions = '') {
  return `<div class="page-head"><div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="actions">${actions}</div></div>`;
}
const kpis = items => `<div class="kpis">${items.map(k => `<div class="kpi"><div class="v">${k.v}</div><div class="l">${esc(k.l)}</div>${k.d ? `<div class="d muted">${k.d}</div>` : ''}</div>`).join('')}</div>`;

const SEV = { Critical: 'critical', High: 'high', Medium: 'medium', Low: '' };
const sevBadge = s => `<span class="badge ${SEV[s] ?? ''}">${esc(s)}</span>`;
const GOOD = ['Live', 'Fixed', 'Approved', 'Passed', 'Healthy', 'Validated', 'Active', 'done'];
const WARN = ['Waiting', 'Awaiting approval', 'Fix in approval', 'Rolling out', 'Changes requested', 'Drifting', 'Pending', 'running', 'Fix validated'];
const BAD = ['Rejected', 'Rolled back', 'Below threshold', 'failed', 'cancelled'];
const status = s => `<span class="badge ${GOOD.includes(s) ? 'good' : WARN.includes(s) ? 'warn' : BAD.includes(s) ? 'bad' : 'info'}">${esc(s)}</span>`;
const empty = (msg, action = '') => `<div class="empty">${msg}${action ? `<div style="margin-top:12px">${action}</div>` : ''}</div>`;

function renderHealthPanel() {
  const root = $('#startup-health');
  if (!root) return;
  const h = S.health;
  if (!h) { root.innerHTML = ''; return; }
  const slm = h.slm || {};
  const run = h.run || null;
  const fallback = h.fallback || 'disabled';
  const runDone = run?.finished_at || run?.started_at || null;
  root.innerHTML = `<div class="health-grid">
    <div class="health-card"><div class="health-title">SLM runtime</div><div class="health-v">${slm.ready ? 'Local llama.cpp ready' : 'Local runtime unavailable'}</div>
      <div class="small muted">${esc((slm.probe || slm.url || '127.0.0.1:8080'))}</div><div class="health-ts">Refreshed ${fmtTs(h.refreshed_at)}</div></div>
    <div class="health-card"><div class="health-title">Fallback</div><div class="health-v">${esc(fallback)}</div>
      <div class="small muted">Used only when local clustering fails</div></div>
    <div class="health-card"><div class="health-title">Last ingest run</div><div class="health-v">${run ? `${run.status || 'ok'} · ${num(run.traces || 0)} traces` : 'No ingest run yet'}</div>
      <div class="small muted">${run ? `quarantine ${num(run.line_quarantined || 0)} · parse errors ${num(run.parse_errors || 0)}` : 'Run /api/ingest/run to initialize'}</div>
      <div class="health-ts">Completed ${fmtTs(runDone)}</div></div>
  </div>`;
}

async function refreshHealthPanel() {
  try {
    const [slm, runs] = await Promise.all([api('/api/slm/status'), api('/api/ingest/runs?limit=1')]);
    const cfg = S.boot?.settings || {};
    S.health = {
      slm: { ready: !!slm.probe?.ready, url: cfg.llama_server_url || 'http://127.0.0.1:8080', probe: slm.probe?.url || cfg.llama_server_url },
      fallback: cfg.semantic_fallback_enabled ? `Anthropic: ${cfg.anthropic_fallback_model || 'haiku'}` : 'disabled',
      run: runs.items?.[0] || null,
      refreshed_at: new Date().toISOString(),
    };
  } catch (e) {
    S.health = { slm: { ready: false }, fallback: 'unknown', run: null, refreshed_at: new Date().toISOString() };
  }
  renderHealthPanel();
}

function observeOnly(a) {
  return `<div class="panel">${empty(`${esc(a.name)} is connected as <b>${esc(a.integration.toLowerCase())}</b>. This demo simulates traces for the billing and outage agents only. Pick one of them from the agent menu, or test a proven pattern against this agent from the <a href="#/patterns">pattern library</a>.`)}</div>`;
}

/* ------------------------------------------------------------------ charts (inline SVG) */
function lineChart({ series, labels = [], height = 220, yFmt = v => pct(v, 0), yMin, yMax, markers = [] }) {
  const W = 720, H = height, L = 46, R = 12, T = 12, B = 28;
  const all = series.flatMap(s => s.values.filter(v => v != null));
  let lo = yMin ?? Math.min(...all), hi = yMax ?? Math.max(...all);
  if (!(hi > lo)) { hi = lo + 1; }
  const pad = (hi - lo) * 0.08; if (yMin == null) lo -= pad; if (yMax == null) hi += pad;
  const n = Math.max(...series.map(s => s.values.length));
  const x = i => L + (n <= 1 ? 0 : i * (W - L - R) / (n - 1));
  const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  let g = '';
  for (let k = 0; k <= 4; k++) {
    const v = lo + (hi - lo) * k / 4;
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#EEEEEE"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(yFmt(v))}</text>`;
  }
  const step = Math.ceil(n / 8);
  labels.forEach((l, i) => { if (i % step === 0 || i === n - 1) g += `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === n - 1 && n > 1 ? 'end' : i === 0 ? 'start' : 'middle'}">${esc(l)}</text>`; });
  markers.forEach(m => {
    g += `<line x1="${x(m.i)}" x2="${x(m.i)}" y1="${T}" y2="${H - B}" stroke="#EE0000" stroke-dasharray="4 4"/>` +
      `<text x="${x(m.i) + 5}" y="${T + 11}" style="fill:#EE0000">${esc(m.label)}</text>`;
  });
  series.forEach(s => {
    const pts_ = s.values.map((v, i) => v == null ? null : [x(i), y(v)]).filter(Boolean);
    if (!pts_.length) return;
    g += `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width || 2.2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round" points="${pts_.map(p => p.join(',')).join(' ')}"/>`;
    if (s.dots) pts_.forEach(p => { g += `<circle cx="${p[0]}" cy="${p[1]}" r="3.2" fill="#fff" stroke="${s.color}" stroke-width="2"/>`; });
  });
  const legend = series.length > 1 ? `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${g}</svg>${legend}`;
}

function scatter({ points, xFmt = v => num(v), yFmt = v => pct(v, 0), xLabel = '', yLabel = '' }) {
  const W = 560, H = 280, L = 52, R = 20, T = 16, B = 40;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  let [x0, x1] = [Math.min(...xs), Math.max(...xs)], [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const px = (x1 - x0 || x0 * 0.1 || 1) * 0.15, py = (y1 - y0 || 0.05) * 0.2;
  x0 -= px; x1 += px; y0 -= py; y1 += py;
  const X = v => L + (W - L - R) * (v - x0) / (x1 - x0), Y = v => T + (H - T - B) * (1 - (v - y0) / (y1 - y0));
  let g = '';
  for (let k = 0; k <= 3; k++) {
    const vy = y0 + (y1 - y0) * k / 3, vx = x0 + (x1 - x0) * k / 3;
    g += `<line x1="${L}" x2="${W - R}" y1="${Y(vy)}" y2="${Y(vy)}" stroke="#EEEEEE"/><text x="${L - 6}" y="${Y(vy) + 4}" text-anchor="end">${esc(yFmt(vy))}</text>`;
    g += `<text x="${X(vx)}" y="${H - 22}" text-anchor="middle">${esc(xFmt(vx))}</text>`;
  }
  g += `<text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">${esc(xLabel)}</text>`;
  g += `<text x="12" y="${T + (H - T - B) / 2}" transform="rotate(-90 12 ${T + (H - T - B) / 2})" text-anchor="middle">${esc(yLabel)}</text>`;
  points.forEach(p => {
    g += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${p.r || 7}" fill="${p.color}" fill-opacity=".9" stroke="#fff" stroke-width="2"/>` +
      `<text x="${X(p.x) + 11}" y="${Y(p.y) + 4}" style="fill:#000000;font-weight:500">${esc(p.label)}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
}

function spark(values, color = '#000000', w = 96, h = 26, thr = null) {
  if (!values || values.length < 2) return '';
  const lo = Math.min(...values, thr ?? 1), hi = Math.max(...values, thr ?? 0);
  const x = i => 2 + i * (w - 4) / (values.length - 1), y = v => 2 + (h - 4) * (1 - (v - lo) / ((hi - lo) || 1));
  const t = thr != null ? `<line x1="0" x2="${w}" y1="${y(thr)}" y2="${y(thr)}" stroke="#EE0000" stroke-dasharray="2 2" stroke-width="1"/>` : '';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${t}<polyline fill="none" stroke="${color}" stroke-width="1.8" points="${values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/></svg>`;
}
const hbar = (label, v, max, red) => `<div class="hbar"><div><div class="small">${esc(label)}</div><div class="bar ${red ? 'red' : ''}"><span style="width:${Math.max(2, 100 * v / (max || 1))}%"></span></div></div><div class="num small">${num(v)}</div></div>`;

/* ------------------------------------------------------------------ before / after replay */
const ROLE = { customer: 'Customer', agent: 'Agent' };
function msgHTML(m, extra = '') {
  if (m.role === 'tool') {
    const args = Object.entries(m.args || {}).map(([k, v]) => `${k}=${v}`).join(', ');
    return `<div class="tool ${/BLOCKED/.test(m.text) ? 'blocked' : ''}">⚙ <b>${esc(m.name)}</b>(${esc(args)}) → ${esc(m.text)}</div>`;
  }
  if (m.role === 'system') return `<div class="sysmsg ${/session ended/.test(m.text) ? 'end' : ''}">${esc(m.text)}</div>`;
  return `<div class="msg ${m.role} ${extra}"><span class="who">${ROLE[m.role]}</span>${esc(m.text)}</div>`;
}

function outcomeHTML(side) {
  const e = side.eval, res = e.resolution, o = e.outcome;
  return `<div class="outcome">
    <div class="verdict"><span class="dot ${side.gold ? 'good' : 'bad'}"></span>${side.gold ? 'Resolved' : 'Not resolved'} <span class="muted small" style="font-weight:400">(human audit)</span></div>
    <div><span class="k">Resolution judge</span><br>${res.pass ? '<span class="pos">Pass</span>' : '<span class="neg">Fail</span>'} · ${fx(res.score)}</div>
    <div><span class="k">Repeat contact</span><br>${o.repeat_contact ? `<span class="neg">Yes, ${o.repeat_hours} h later</span>` : 'None in 72 h'}</div>
    <div><span class="k">Policy</span><br>${e.policy.pass ? 'Pass' : `<span class="neg">${esc(e.policy.detail)}</span>`}</div>
    <div><span class="k">Tool sequence</span><br>${e.tool_sequence.anomaly ? `<span class="neg">${esc(e.tool_sequence.detail)}</span>` : 'Expected order'}</div>
    <div><span class="k">Tokens</span><br>${num(side.tokens)}</div>
    <div><span class="k">Latency</span><br>${fx(side.latency, 1)} s</div>
    <div style="grid-column:1/-1" class="muted small">Judge rationale: ${esc(res.rationale)}</div>
  </div>`;
}

function forkText(r) {
  const ch = [];
  r.before.decisions.forEach((d, i) => {
    const a = r.after.decisions[i];
    if (a && a.d === d.d && a.a !== d.a) ch.push(`${r.decision_labels[d.d]}: <b>${esc(r.action_labels[d.a])}</b> → <b>${esc(r.action_labels[a.a])}</b>`);
  });
  if (ch.length) return ch.slice(0, 2).join(' · ');
  const gates = r.after.harness.gates.filter(g => !r.before.harness.gates.includes(g));
  if (gates.length) return `Gate fires: <b>${esc(S.boot.library.gates[gates[0]].text)}</b>`;
  return 'The harness change takes effect here';
}

function renderReplay(r) {
  const d = r.divergence;
  const B = r.before, A = r.after;
  if (d < 0) {
    return `<details class="shared" open><summary><span>Identical under both harnesses · ${B.messages.length} messages</span><span>${esc(r.scenario.label)}</span></summary>
      <div class="msgs">${B.messages.map(m => msgHTML(m)).join('')}</div></details>
      <div class="fork none"><span>No divergence: this change does not alter this conversation</span></div>
      <div class="lanes"><div class="lane before">${laneHead('Before', B)}${outcomeHTML(B)}</div><div class="lane after">${laneHead('After', A)}${outcomeHTML(A)}</div></div>`;
  }
  const prefix = B.messages.slice(0, d), older = prefix.slice(0, -2), tail = prefix.slice(-2);
  const shared = prefix.length ? `<div class="shared"><div class="shared-head"><span>Same in both versions · ${prefix.length} message${prefix.length === 1 ? '' : 's'}</span><span>${esc(r.scenario.label)} · seed ${r.scen_seed}</span></div>
      ${older.length ? `<details><summary>Show ${older.length} earlier message${older.length === 1 ? '' : 's'}</summary><div class="msgs">${older.map(m => msgHTML(m)).join('')}</div></details>` : ''}
      <div class="msgs">${tail.map(m => msgHTML(m)).join('')}</div></div>` : '';
  return `${shared}
    <div class="fork"><span>${forkText(r)}</span></div>
    <div class="lanes">
      <div class="lane before">${laneHead('Before', B)}<div class="msgs">${B.messages.slice(d).map(m => msgHTML(m, 'new')).join('')}</div>${outcomeHTML(B)}</div>
      <div class="lane after">${laneHead('After', A)}<div class="msgs">${A.messages.slice(d).map(m => msgHTML(m, 'new')).join('')}
        ${A.truncated ? '<div class="sysmsg">Prefix replay: stops after the first changed turn</div>' : ''}</div>${outcomeHTML(A)}</div>
    </div>
    <details class="decisions"><summary class="muted small" style="cursor:pointer;margin-top:12px">Decision probabilities at each step</summary>
      <table><tr><th>Decision</th><th>Before</th><th>After</th></tr>
      ${B.decisions.map((x, i) => { const y = A.decisions[i]; return `<tr><td>${esc(r.decision_labels[x.d])}</td><td>${esc(r.action_labels[x.a])} <span class="faint">p=${fx(x.p[x.a])}</span></td><td>${y ? `${esc(r.action_labels[y.a])} <span class="faint">p=${fx(y.p[y.a])}</span>` : '—'}</td></tr>`; }).join('')}
      </table></details>`;
}
const laneHead = (label, side) => `<div class="lane-head"><span class="who">${label}</span><span class="small muted">${esc(side.harness.name)}</span></div>`;

/* A replay widget: example picker, mode, simulator-error, and the split conversation. */
function replayWidget(id, opts) {
  const R = { ...opts, mode: 'simulator', sim: 0 };
  S[`replay_${id}`] = R;
  const traceCtl = opts.traceId ? `<div class="grow"><label class="field">Trace<span class="mono" style="color:var(--ink);padding:7px 0">${esc(opts.traceId)}</span></label></div>`
    : `<div class="grow"><label class="field">Example conversation<select id="${id}-ex" data-change="${id}-pick"><option>Loading examples…</option></select></label></div>
       <button class="btn sm" data-act="${id}-random">Random scenario</button>`;
  const html = `<div class="replay" id="${id}">
    <div class="replay-bar">${traceCtl}
      <label class="field">Replay mode<div class="seg" role="group"><button class="on" data-act="${id}-mode" data-mode="simulator">Full simulator</button><button data-act="${id}-mode" data-mode="prefix">Prefix only</button></div></label>
      <label class="field">Simulated-customer error <span id="${id}-simv">0%</span><input type="range" min="0" max="0.4" step="0.05" value="0" data-change="${id}-sim"></label>
    </div>
    <div class="replay-body" id="${id}-body"><div class="loading">Replaying…</div></div></div>`;

  const run = async (extra = {}) => {
    const body = { base_id: R.base, cand_id: R.cand, mode: R.mode, sim_error: R.sim, ...extra };
    if (R.traceId) body.trace_id = R.traceId;
    else if (R.current?.trace_id) body.trace_id = R.current.trace_id;
    else if (R.current?.scen_seed) { body.scen_seed = R.current.scen_seed; body.samp_seed = R.current.scen_seed; }
    const el = $(`#${id}-body`); if (!el) return;
    el.style.opacity = .5;
    try { const r = await post('/api/replay', body); el.innerHTML = renderReplay(r); } catch (e) { el.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
    el.style.opacity = 1;
  };
  ACT[`${id}-mode`] = el => { R.mode = el.dataset.mode; $$(`#${id} .seg button`).forEach(b => b.classList.toggle('on', b === el)); run(); };
  ACT[`${id}-sim`] = el => { R.sim = +el.value; $(`#${id}-simv`).textContent = pct(R.sim, 0); run(); };
  ACT[`${id}-pick`] = el => { if (el.value === '') return; R.current = R.examples[+el.value]; run(); };
  ACT[`${id}-random`] = () => { R.current = { scen_seed: 40000 + Math.floor(Math.random() * 20000) }; const s = $(`#${id}-ex`); if (s) s.value = ''; run(); };
  const init = async () => {
    if (!R.traceId) {
      R.examples = await api(`/api/replay-examples?base_id=${encodeURIComponent(R.base)}&cand_id=${encodeURIComponent(R.cand)}${R.theme ? `&theme=${encodeURIComponent(R.theme)}` : ''}`);
      const sel = $(`#${id}-ex`); if (!sel) return;
      sel.innerHTML = R.examples.length ? R.examples.map((x, i) => `<option value="${i}">${esc(x.trace_id)} · ${esc(x.label)} · “${esc(x.snippet.slice(0, 48))}”${x.fixed ? ' · fixed' : x.regressed ? ' · regressed' : ''}</option>`).join('')
        : '<option value="">No production trace changes under this candidate — try a random scenario</option>';
      R.current = R.examples[0] || { scen_seed: 40001 };
    }
    run();
  };
  return { html, init };
}

/* ================================================================== views */
const RANGES = [['24h', 'Last 24h'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['12m', 'Last 12 months'], ['custom', 'Custom']];
function overviewQuery() {
  const q = S.query, r = q.get('range') || S.ovRange?.range || '7d';
  const from = q.get('from') || S.ovRange?.from || '', to = q.get('to') || S.ovRange?.to || '';
  S.ovRange = { range: r, from, to };
  return r === 'custom' && from && to ? `range=custom&start=${from}&end=${to}` : `range=${r === 'custom' ? '7d' : r}`;
}

function ingestQuery() {
  const q = S.query, r = q.get('range') || S.ingRange?.range || '7d';
  const from = q.get('from') || S.ingRange?.from || '', to = q.get('to') || S.ingRange?.to || '';
  S.ingRange = { range: r, from, to };
  return r === 'custom' && from && to ? `range=custom&start=${from}&end=${to}` : `range=${r === 'custom' ? '7d' : r}`;
}

function overviewFilters(d) {
  const w = d.window, r = S.ovRange.range, custom = r === 'custom';
  return `<div class="ov-filters">
    <label class="ov-field"><span>Agent</span><select data-change="ovagent">${S.boot.agents.map(a => `<option value="${a.id}" ${a.id === S.agent ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
    <div class="ov-field"><span id="ptl">Production traffic</span>
      <div class="seg ov-seg" role="group" aria-labelledby="ptl">${RANGES.map(([k, l]) => `<button type="button" class="${k === r ? 'on' : ''}" aria-pressed="${k === r}" data-act="ovrange" data-r="${k}">${l}</button>`).join('')}</div>
      ${custom ? `<div class="ov-custom"><input type="date" id="ovfrom" value="${S.ovRange.from || w.start}" min="${w.min}" max="${w.max}" aria-label="From">
        <span class="faint">to</span><input type="date" id="ovto" value="${S.ovRange.to || w.end}" min="${w.min}" max="${w.max}" aria-label="To">
        <button class="btn sm" data-act="ovapply">Apply</button></div>` : ''}</div>
    <button class="btn ov-run" data-act="analyze" data-busy="Analyzing…">Run analysis</button>
  </div>`;
}

async function vOverview() {
  crumbs([['Overview']]);
  const d = await api(`/api/overview/${S.agent}?${overviewQuery()}`);
  const w = d.window;
  const headHTML = body => `<div class="page-head ov-head"><div><h1>Overview</h1><div class="sub">${body}</div></div>${overviewFilters(d)}</div>`;
  ACT.ovagent = el => { S.agent = el.value; $('#agent').value = el.value; route(); };
  ACT.ovrange = el => {
    const r = el.dataset.r;
    if (r === 'custom') { S.ovRange = { ...S.ovRange, range: 'custom', from: S.ovRange.from || w.start, to: S.ovRange.to || w.end }; location.hash = `#/overview?range=custom&from=${S.ovRange.from}&to=${S.ovRange.to}`; }
    else location.hash = `#/overview?range=${r}`;
  };
  ACT.ovapply = () => {
    const f = $('#ovfrom').value, t = $('#ovto').value;
    if (!f || !t) { toast('Pick both dates.', true); return; }
    location.hash = `#/overview?range=custom&from=${f}&to=${t}`;
  };
  ACT.analyze = btn => busy(btn, async () => { await post(`/api/analysis/${S.agent}`); toast('Analysis complete: themes re-clustered'); route(); });
  if (!d.production) { page(headHTML(esc(d.agent.name)) + observeOnly(d.agent)); return; }
  const k = d.kpis;
  const clipped = w.range === '30d' && w.available_days < 30 ? ` (only ${w.available_days} days of traces available)` : '';
  const sub = `Production traces analyzed for failure themes and harness fixes<br><span class="small">${esc(d.production.version)} in production · ${esc(w.label)}${clipped}</span>`;
  if (!k.traces) { page(headHTML(sub) + `<div class="panel">${empty('No production traces in this window. Pick a range between ' + esc(w.min) + ' and ' + esc(w.max) + '.')}</div>`); return; }
  const markers = d.releases.map(r => ({ i: r.day, label: `${r.version} released` }));
  const maxSig = Math.max(...d.signals.map(s => s.value), 1);
  const hourly = w.days === 1;
  page(`${headHTML(sub)}
    ${kpis([{ v: num(k.traces), l: 'Traces analyzed' }, { v: num(k.flagged), l: 'Flagged sessions', d: `${pct(k.flag_rate)} of traces` },
      { v: k.themes, l: 'Failure themes', d: `${k.critical} critical` }, { v: k.waiting, l: 'Waiting for approval', d: '<a href="#/approvals">Review queue</a>' }])}
    <div class="grid-main"><div>
      <div class="panel"><div class="panel-head"><h2>Flagged-session rate</h2><span class="muted small">Share of each ${hourly ? 'hour' : 'day'}'s sessions flagged by any signal</span></div>
        ${lineChart({ series: [{ name: 'Flagged', color: '#000000', values: d.daily.map(x => x.rate), dots: true }], labels: d.daily.map(x => x.date), markers, yMin: 0, yMax: Math.min(1, Math.max(...d.daily.map(x => x.rate)) * 1.12 || 1) })}</div>
      <div class="panel"><div class="panel-head"><h2>Failure themes</h2><a href="#/themes">All themes</a></div>${themeTable(d.themes)}</div>
    </div><div>
      <div class="panel"><h2>Detection signals</h2>${d.signals.map(s => hbar(s.label, s.value, maxSig)).join('')}</div>
      <div class="panel"><h2>Production harness</h2>
        <div class="kv"><span class="k">Version</span><span>${esc(d.production.version)}</span><span class="k">Integration</span><span>${esc(d.agent.integration)}</span>
        <span class="k">Gates</span><span>${d.production.gates.length ? d.production.gates.map(g => esc(S.boot.library.gates[g].text)).join('<br>') : 'None'}</span></div>
        <ul class="small" style="padding-left:18px;margin:12px 0 0">${d.production.lines.map(l => `<li>${esc(S.boot.library.lines[l].text)}${S.boot.library.lines[l].frozen ? ' <span class="lock">frozen</span>' : ''}</li>`).join('')}</ul></div>
    </div></div>`);
}

function ingestFilters(d, mirrorLabel) {
  const w = d.window || {}, r = S.ingRange?.range || '7d', custom = r === 'custom';
  return `<div class="ov-filters">
    <label class="ov-field"><span>Mirror target <span class="cmp-tag">New traces</span></span><select disabled><option>${esc(mirrorLabel)}</option></select></label>
    <div class="ov-field"><span id="itl">Ingested trace window</span>
      <div class="seg ov-seg" role="group" aria-labelledby="itl">${RANGES.map(([k, l]) => `<button type="button" class="${k === r ? 'on' : ''}" aria-pressed="${k === r}" data-act="irange" data-r="${k}">${l}</button>`).join('')}</div>
      ${custom ? `<div class="ov-custom"><input type="date" id="ifrom" value="${S.ingRange.from || w.start || ''}" aria-label="From">
        <span class="faint">to</span><input type="date" id="ito" value="${S.ingRange.to || w.end || ''}" aria-label="To">
        <button class="btn sm" data-act="iapply">Apply</button></div>` : ''}</div>
  </div>`;
}

function mirrorShell(section, label, ing) {
  return head(`${esc(label)} · New Trace Mirror`, `Specialized mirror tab using persisted ingestion KPI payload for comparison.`, `${ingestFilters(ing, label)}<a class="btn" href="#/${section}">Open original tab</a>`);
}

function mirrorCommonKpis(ing, old) {
  const n = ing.summary || {};
  const o = old?.kpis || {};
  const dfail = o.flag_rate == null || n.failure_rate == null ? '—' : pts(n.failure_rate - o.flag_rate, 2);
  const dlat = o.p95 == null || n.trace_p95_latency_sec == null ? '—' : `${sign(n.trace_p95_latency_sec - o.p95, 2)} s`;
  return kpis([
    { v: num(n.total_traces), l: 'Ingested traces', d: ing.window ? `${ing.window.start} to ${ing.window.end}` : '' },
    { v: pct(n.failure_rate), l: 'Failure rate (new traces)', d: `vs original ${dfail}` },
    { v: n.trace_p95_latency_sec == null ? '—' : `${fx(n.trace_p95_latency_sec, 2)} s`, l: 'Trace P95 latency', d: `vs original ${dlat}` },
    { v: n.cost_per_eval_run == null ? '—' : fx(n.cost_per_eval_run, 4), l: 'Cost per eval run', d: 'metric-cost fields only' },
  ]);
}

function renderMirrorThemes(section, label, ing, old, themes) {
  const rows = (ing.failure_buckets || []).filter(r => r.bucket !== 'Pass');
  const top = rows[0];
  return `${mirrorShell(section, label, ing)}
    ${mirrorCommonKpis(ing, old)}
    <div class="grid-main"><div>
      <div class="panel"><div class="panel-head"><h2>Ingested failure clusters</h2><span class="small muted">Bucket-level equivalents for theme drift</span></div>
        <table><tr><th>Bucket</th><th class="num">Count</th><th class="num">Rate</th></tr>
          ${rows.map(r => `<tr><td>${esc(r.bucket)}</td><td class="num">${num(r.count)}</td><td class="num">${pct(r.rate, 2)}</td></tr>`).join('') || `<tr><td colspan="3" class="muted">No failing buckets in selected window.</td></tr>`}
        </table></div>
      <div class="panel"><div class="panel-head"><h2>Daily failure trend</h2><span class="small muted">New traces only</span></div>
        ${lineChart({ series: [{ name: 'Failure rate', color: '#EE0000', values: (ing.daily || []).map(x => x.failure_rate), dots: true }], labels: (ing.daily || []).map(x => x.event_date || ''), yMin: 0, yMax: 1 })}
      </div>
    </div><div>
      <div class="panel"><h2>Theme comparison snapshot</h2><div class="kv">
        <span class="k">Original theme count</span><span>${num(themes?.length || 0)}</span>
        <span class="k">Top ingested failure</span><span>${top ? `${esc(top.bucket)} (${pct(top.rate, 1)})` : '—'}</span>
        <span class="k">Open original themes</span><span><a href="#/themes">View source themes</a></span>
      </div></div>
    </div></div>`;
}

function renderMirrorFixes(section, label, ing, old, bundles) {
  const failing = (ing.failure_buckets || []).filter(r => r.bucket !== 'Pass');
  const prioritized = failing.slice(0, 5);
  return `${mirrorShell(section, label, ing)}
    ${mirrorCommonKpis(ing, old)}
    <div class="grid-main"><div>
      <div class="panel"><div class="panel-head"><h2>New-trace fix priorities</h2><span class="small muted">Prioritized by ingest failure volume</span></div>
        <table><tr><th>Priority failure bucket</th><th class="num">Count</th><th class="num">Rate</th><th>Action</th></tr>
          ${prioritized.map((r, i) => `<tr><td>${i + 1}. ${esc(r.bucket)}</td><td class="num">${num(r.count)}</td><td class="num">${pct(r.rate, 2)}</td><td><a href="#/fixes">Review candidate bundles</a></td></tr>`).join('') || `<tr><td colspan="4" class="muted">No failing buckets in selected window.</td></tr>`}
        </table></div>
      <div class="panel"><div class="panel-head"><h2>Daily failure trend</h2><span class="small muted">New traces only</span></div>
        ${lineChart({ series: [{ name: 'Failure rate', color: '#EE0000', values: (ing.daily || []).map(x => x.failure_rate), dots: true }], labels: (ing.daily || []).map(x => x.event_date || ''), yMin: 0, yMax: 1 })}
      </div>
    </div><div>
      <div class="panel"><h2>Original fix inventory</h2><div class="kv">
        <span class="k">Bundles</span><span>${num(bundles?.length || 0)}</span>
        <span class="k">Candidate fixes</span><span>${num((bundles || []).reduce((s, b) => s + (b.fixes?.length || 0), 0))}</span>
        <span class="k">Open fix tab</span><span><a href="#/fixes">Fix bundles</a></span>
      </div></div>
    </div></div>`;
}

function renderMirrorJudges(section, label, ing, old, judges) {
  const n = ing.summary || {};
  return `${mirrorShell(section, label, ing)}
    ${mirrorCommonKpis(ing, old)}
    <div class="grid-main"><div>
      <div class="panel"><h2>Judge-risk signals from ingested traces</h2>
        <table><tr><th>Signal</th><th class="num">Observed</th><th>Interpretation</th></tr>
          <tr><td>Failure rate</td><td class="num">${pct(n.failure_rate, 2)}</td><td class="small">High failure volume increases chance of judge disagreement hotspots.</td></tr>
          <tr><td>Policy violation incidence</td><td class="num">${n.policy_violation_incidence == null ? '—' : pct(n.policy_violation_incidence, 2)}</td><td class="small">Higher policy violations indicate stricter fail conditions for resolution judges.</td></tr>
          <tr><td>Retry/escalation rate</td><td class="num">${n.retry_escalation_rate == null ? '—' : pct(n.retry_escalation_rate, 2)}</td><td class="small">Escalations often correlate with harder sessions for judge calibration.</td></tr>
        </table></div>
      <div class="panel"><div class="panel-head"><h2>Daily failure trend</h2><span class="small muted">New traces only</span></div>
        ${lineChart({ series: [{ name: 'Failure rate', color: '#EE0000', values: (ing.daily || []).map(x => x.failure_rate), dots: true }], labels: (ing.daily || []).map(x => x.event_date || ''), yMin: 0, yMax: 1 })}
      </div>
    </div><div>
      <div class="panel"><h2>Current judge baseline</h2><div class="kv">
        <span class="k">Resolution κ</span><span>${judges?.kappa == null ? '—' : fx(judges.kappa, 3)}</span>
        <span class="k">Threshold</span><span>${judges?.threshold == null ? '—' : fx(judges.threshold, 3)}</span>
        <span class="k">Status</span><span>${judges?.kappa != null && judges.threshold != null && judges.kappa >= judges.threshold ? '<span class="badge good">Healthy</span>' : '<span class="badge warn">Check</span>'}</span>
        <span class="k">Deep-dive tab</span><span><a href="#/judges">Open original judges view</a></span>
      </div></div>
    </div></div>`;
}

function renderMirrorGeneric(section, label, ing, old) {
  const rows = ing.failure_buckets || [];
  const n = ing.summary || {};
  return `${mirrorShell(section, label, ing)}
    ${mirrorCommonKpis(ing, old)}
    <div class="grid-main"><div>
      <div class="panel"><div class="panel-head"><h2>Failure-bucket distribution</h2><span class="small muted">Ingestion pipeline aggregate</span></div>
        <table><tr><th>Bucket</th><th class="num">Count</th><th class="num">Rate</th></tr>
          ${rows.map(r => `<tr><td>${esc(r.bucket)}</td><td class="num">${num(r.count)}</td><td class="num">${pct(r.rate, 2)}</td></tr>`).join('') || `<tr><td colspan="3" class="muted">No rows in selected window.</td></tr>`}
        </table></div>
      <div class="panel"><div class="panel-head"><h2>Daily failure trend</h2><span class="small muted">New traces only</span></div>
        ${lineChart({ series: [{ name: 'Failure rate', color: '#EE0000', values: (ing.daily || []).map(x => x.failure_rate), dots: true }], labels: (ing.daily || []).map(x => x.event_date || ''), yMin: 0, yMax: 1 })}
      </div>
    </div><div>
      <div class="panel"><h2>Operational snapshot</h2><div class="kv">
        <span class="k">Retry or escalation</span><span>${n.retry_escalation_rate == null ? '—' : pct(n.retry_escalation_rate, 2)}</span>
        <span class="k">Policy-violation incidence</span><span>${n.policy_violation_incidence == null ? '—' : pct(n.policy_violation_incidence, 2)}</span>
        <span class="k">Source mode</span><span>Persisted ingestion DB</span>
      </div></div>
      <div class="panel"><h2>Comparison guidance</h2><p class="small muted">Use this mirror tab against the original tab of the same name to compare behavior before and after new trace batches are ingested.</p></div>
    </div></div>`;
}

async function vIngestMirror(section) {
  const base = BASE_NAV.filter(([k]) => !['label', 'sep'].includes(k));
  const found = base.find(([k]) => k === section);
  const label = found ? found[1] : section;
  crumbs([[`New Trace Mirror`], [`${label}`]]);
  const extraReq = section === 'themes' ? api(`/api/themes/${S.agent}`)
    : section === 'fixes' ? api(`/api/bundles?agent=${S.agent}`)
      : section === 'judges' ? api(`/api/hood/judges/${S.agent}`)
        : Promise.resolve(null);

  const [ing, old, extra] = await Promise.all([
    api(`/api/ingest/overview?${ingestQuery()}`),
    api(`/api/overview/${S.agent}?${overviewQuery()}`).catch(() => null),
    extraReq.catch(() => null),
  ]);
  ACT.irange = el => {
    const r = el.dataset.r;
    if (r === 'custom') {
      const d = ing.window || {};
      S.ingRange = { ...S.ingRange, range: 'custom', from: S.ingRange.from || d.start || '', to: S.ingRange.to || d.end || '' };
      location.hash = `#/ingest/${section}?range=custom&from=${S.ingRange.from}&to=${S.ingRange.to}`;
    } else {
      location.hash = `#/ingest/${section}?range=${r}`;
    }
  };
  ACT.iapply = () => {
    const f = $('#ifrom').value, t = $('#ito').value;
    if (!f || !t) { toast('Pick both dates.', true); return; }
    location.hash = `#/ingest/${section}?range=custom&from=${f}&to=${t}`;
  };

  if (section === 'themes') { page(renderMirrorThemes(section, label, ing, old, extra)); return; }
  if (section === 'fixes') { page(renderMirrorFixes(section, label, ing, old, extra)); return; }
  if (section === 'judges') { page(renderMirrorJudges(section, label, ing, old, extra)); return; }
  page(renderMirrorGeneric(section, label, ing, old));
}

function themeTable(ts) {
  if (!ts.length) return empty('No failure themes yet. Run analysis to cluster flagged traces.');
  return `<div class="table-wrap"><table><tr><th>Theme</th><th>Severity</th><th class="num">Traces</th><th class="num">Trend 7d</th><th class="num">Repeat contact</th><th>Status</th></tr>
    ${ts.map(t => `<tr class="click" data-href="#/themes/${t.id}"><td>${esc(t.name)}<div class="small muted">${esc(t.layer)} · first seen ${esc(t.first_seen)}</div></td>
      <td>${sevBadge(t.sev)}</td><td class="num">${num(t.traces)}</td><td class="num ${t.trend > 0 ? 'neg' : 'pos'}">${t.trend == null ? '<span class="faint">n/a</span>' : `${sign(t.trend * 100)}%`}</td>
      <td class="num">${pct(t.repeat_rate, 0)}</td><td>${status(t.status)}</td></tr>`).join('')}</table></div>`;
}

async function vThemes() {
  crumbs([['Failure themes']]);
  const ts = await api(`/api/themes/${S.agent}`);
  page(`${head('Failure themes', 'Flagged traces clustered by shared failure signature. Each theme links to evidence, a root-cause hypothesis and a fix bundle.')}
    <div class="panel">${themeTable(ts)}</div>`);
}

async function vTheme(tid) {
  const t = await api(`/api/theme/${tid}`);
  crumbs([['Failure themes', '#/themes'], [t.name]]);
  const rc = t.root_cause;
  const acts = t.bundle_id ? `<a class="btn primary" href="#/fixes/${t.bundle_id}/F-1">Open fix bundle</a>`
    : `<button class="btn primary" data-act="gen" data-busy="Proposing fixes…">Generate fix bundle</button>`;
  page(`${head(`${esc(t.name)} ${sevBadge(t.sev)}`, `${esc(t.desc)}`, `${acts}<a class="btn" href="#/regression?theme=${t.id}">Convert to regression tests</a>`)}
    ${kpis([{ v: num(t.traces), l: 'Traces in theme', d: `${pct(t.share, 0)} of flagged sessions` }, { v: pct(t.repeat_rate, 0), l: 'Repeat contact', d: `vs ${pct(t.repeat_base, 0)} agent baseline` },
      { v: fx(t.csat, 1), l: 'Average CSAT' }, { v: esc(t.first_seen), l: 'First seen', d: `${sign(t.trend * 100)}% week over week` }])}
    <div class="grid-main"><div>
      <div class="panel"><h2>Root-cause hypothesis</h2><p>${esc(rc.text)}</p>
        <div class="kv" style="margin-top:10px"><span class="k">Confidence</span><span><div class="bar" style="width:180px;display:inline-block;vertical-align:middle"><span style="width:${rc.confidence * 100}%"></span></div> ${fx(rc.confidence)}</span>
        <span class="k">Suspected layer</span><span>${esc(t.layer)}</span>
        ${rc.change ? `<span class="k">Correlated change</span><span><span class="mono">${esc(rc.change.from)} → ${esc(rc.change.to)}</span></span>` : ''}</div></div>
      <div class="panel"><h2>Daily occurrences</h2>${lineChart({ series: [{ name: 'Traces', color: '#EE0000', values: t.daily }], labels: t.daily.map((_, i) => `d${i}`), yFmt: v => num(v), yMin: 0, height: 170 })}</div>
      <div class="panel"><div class="panel-head"><h2>Evidence</h2><a href="#/traces?theme=${t.id}">All ${num(t.evidence_total)} traces</a></div>${traceTable(t.evidence)}</div>
    </div><div>
      <div class="panel"><h2>Sub-clusters</h2>${t.subclusters.map(s => `<div class="hbar"><div><div class="small">${esc(s.label)}</div><div class="bar"><span style="width:${s.share * 100}%"></span></div></div><div class="num small">${pct(s.share, 0)}</div></div>`).join('')}</div>
      <div class="panel"><h2>Fix bundle</h2>${t.bundle ? t.bundle.fixes.map(f => `<div class="approver"><div><a href="#/fixes/${t.bundle_id}/${f.id}">${f.id} · ${esc(f.title)}</a><div class="small muted">${esc(f.layer)} · ${esc(f.risk)} risk</div></div>${status(f.status)}</div>`).join('')
        : empty('No fixes proposed yet.', '<button class="btn sm" data-act="gen" data-busy="Proposing…">Generate fix bundle</button>')}</div>
      <div class="panel"><h2>Regression tests</h2><p class="muted">About ${t.suggested_tests} deduplicated tests can be generated from this theme's evidence.</p><a class="btn sm" href="#/regression?theme=${t.id}">Convert to tests</a></div>
    </div></div>`);
  ACT.gen = btn => busy(btn, async () => { const b = await post(`/api/theme/${tid}/bundle`, { n: 600 }); toast(`${b.fixes.length} fixes proposed and validated`); location.hash = `#/fixes/${b.id}/F-1`; });
}

function traceTable(items) {
  if (!items.length) return empty('No traces match.');
  return `<div class="table-wrap"><table><tr><th>Trace</th><th>Scenario</th><th>Customer</th><th>Judge</th><th>Outcome</th><th>Version</th><th>When</th></tr>
    ${items.map(t => `<tr class="click" data-href="#/traces/${t.id}"><td class="mono">${t.id}</td><td>${esc(t.label)}</td><td class="muted">“${esc(t.snippet.slice(0, 44))}”</td>
      <td>${t.judged_pass ? '<span class="pos">Pass</span>' : '<span class="neg">Fail</span>'} <span class="faint">${fx(t.judged_score)}</span></td>
      <td>${t.repeat ? '<span class="neg">Repeat contact</span>' : `CSAT ${t.csat}`}</td><td class="mono">${esc(t.version)}</td><td class="nowrap">${t.date} ${t.time}</td></tr>`).join('')}</table></div>`;
}

/* ------------------------------------------------------------------ fix bundles */
async function vFixes() {
  crumbs([['Fix bundles']]);
  const bs = await api(`/api/bundles?agent=${S.agent}`);
  page(`${head('Fix bundles', 'Each bundle groups candidate harness changes for one failure theme, validated offline against production traffic.')}
    ${bs.length ? bs.map(b => `<div class="panel"><div class="panel-head"><div><h2>${esc(b.theme_name)}</h2><div class="small muted">${b.id} · proposed from ${num(b.proposed_from)} failure traces · ${esc(b.created)}</div></div>
      ${b.combined ? `<div class="small">Best combination (${b.combined.fix_ids.join(' + ')}): <b class="${cls(b.combined.lift.diff)}">${pts(b.combined.lift.diff)}</b> resolution</div>` : ''}</div>
      <table><tr><th>Fix</th><th>Layer</th><th>Risk</th><th class="num">Resolution lift</th><th class="num">95% CI</th><th>Status</th></tr>
      ${b.fixes.map(f => { const v = f.validation, l = v && v.lift; return `<tr class="click" data-href="#/fixes/${b.id}/${f.id}"><td><b>${f.id}</b> ${esc(f.title)}</td><td>${esc(f.layer)}</td><td>${esc(f.risk)}</td>
        <td class="num ${l ? cls(l.diff) : ''}">${l ? pts(l.diff) : v && v.only_evaluator ? `κ ${fx(v.kappa_before)} → ${fx(v.kappa_after)}` : '—'}</td><td class="num muted">${l ? `${pts(l.lo)} to ${pts(l.hi)}` : ''}</td><td>${status(f.status)}</td></tr>`; }).join('')}</table></div>`).join('')
      : `<div class="panel">${empty('No fix bundles for this agent yet.', '<a class="btn" href="#/themes">Open a failure theme</a>')}</div>`}`);
}

const DELIVERY = {
  '1p_repo': [['pr', 'Open pull request'], ['registry', 'Publish to prompt registry'], ['overlay', 'Gateway overlay']],
  '1p_norepo': [['registry', 'Publish to prompt registry'], ['overlay', 'Gateway overlay']],
  '3p_config': [['config_api', 'Push via runtime config API'], ['vendor', 'Vendor change request'], ['overlay', 'Gateway overlay']],
  '3p_observe': [['vendor', 'Vendor change request'], ['overlay', 'Gateway overlay']],
};

function diffRows(rows) {
  return `<div class="diff">${rows.map(r => `<div class="diff-row ${r.mark === '+' ? 'add' : r.mark === '-' ? 'del' : r.mark === '~' ? 'chg' : r.frozen ? 'frozen' : ''}">
    <span class="m">${r.mark === '=' ? '' : r.mark === ' ' ? '' : r.mark}</span><span>${esc(r.text)}${r.before_text && r.mark === '~' ? `<div class="faint small">was: ${esc(r.before_text)}</div>` : ''}</span>
    ${r.frozen ? '<span class="lock">frozen</span>' : r.layer ? `<span class="faint small">${esc(r.layer)}</span>` : '<span></span>'}</div>`).join('')}</div>`;
}

function validationHTML(v) {
  if (!v) return empty('Not validated yet. Replay it against held-out production scenarios.');
  if (v.only_evaluator) return `<p>This fix changes how sessions are <b>scored</b>, not what the agent says, so conversations are unchanged. It is validated by judge–human agreement on the calibration set.</p>
    <div class="kv"><span class="k">Cohen's κ before</span><span>${fx(v.kappa_before)}</span><span class="k">Cohen's κ after</span><span class="${cls(v.kappa_after - v.kappa_before)}">${fx(v.kappa_after)}</span></div>`;
  const row = (l, k, f, better = 1) => { const d = v.cand[k] - v.base[k]; return `<tr><td>${l}</td><td class="num">${f(v.base[k])}</td><td class="num">${f(v.cand[k])}</td><td class="num ${cls(d * better)}">${k === 'tokens' ? sign(100 * d / v.base[k]) + '%' : k === 'p95' ? sign(d, 1) + ' s' : pts(d)}</td></tr>`; };
  return `<table><tr><th>Metric</th><th class="num">Before</th><th class="num">After</th><th class="num">Change</th></tr>
    ${row('Resolution (judge)', 'resolution', pct)}${row('Resolved (human audit)', 'gold', pct)}${row('Repeat contact 72h', 'repeat', pct, -1)}
    ${row('Policy violations', 'violations', v => pct(v, 2), -1)}${row('Tokens per task', 'tokens', num, -1)}${row('P95 latency', 'p95', v => fx(v, 1) + ' s', -1)}</table>
    <p class="small" style="margin-top:10px">Paired bootstrap on ${num(v.n)} held-out scenarios: resolution <b class="${cls(v.lift.diff)}">${pts(v.lift.diff)}</b> (95% CI ${pts(v.lift.lo)} to ${pts(v.lift.hi)})${v.sim_error ? ` · simulator error ${pct(v.sim_error, 0)}` : ''}.</p>
    <div class="chips">${v.regression ? `<span class="badge ${v.regression.gate ? 'good' : 'bad'}">Regression ${v.regression.passed}/${v.regression.total} pass</span>` : ''}
    <span class="badge ${v.frozen_untouched ? 'good' : 'bad'}">Frozen lines ${v.frozen_untouched ? 'untouched' : 'modified'}</span>
    <span class="badge ${v.kappa >= 0.7 ? 'good' : 'warn'}">Judge κ ${fx(v.kappa)}</span></div>`;
}

async function vFix(bid, fid) {
  const f = await api(`/api/fix/${bid}/${fid}`);
  crumbs([['Fix bundles', '#/fixes'], [f.theme.name, `#/themes/${f.theme.id}`], [f.id]]);
  const prev = f.index > 1 ? `#/fixes/${bid}/F-${f.index - 1}` : null, next = f.index < f.count ? `#/fixes/${bid}/F-${f.index + 1}` : null;
  const onlyEval = f.edits.every(e => e.op.includes('criterion'));
  const rw = onlyEval ? null : replayWidget('rp', { base: f.base.id, cand: f.cand.id, theme: f.theme.id });
  const methods = DELIVERY[f.agent.level] || DELIVERY['3p_observe'];
  const cfgChanged = f.config_rows.filter(r => r.mark !== ' ');
  page(`${head(`${f.id} · ${esc(f.title)}`, `${status(f.status)} <span class="badge purple">${esc(f.layer)}</span> <span class="badge">${esc(f.risk)} risk</span> · fix ${f.index} of ${f.count} for <a href="#/themes/${f.theme.id}">${esc(f.theme.name)}</a>`,
    `${prev ? `<a class="btn sm" href="${prev}">Previous fix</a>` : ''}${next ? `<a class="btn sm" href="${next}">Next fix</a>` : ''}`)}
    <div class="grid-main"><div>
      <div class="panel"><div class="panel-head"><h2>Before and after</h2><span class="small muted">${esc(f.base.version)} → ${esc(f.cand.version)} · same customer, same random draws</span></div>
        ${rw ? rw.html : `<div class="alert info">Evaluator-only change: conversations are identical. See the calibration result below.</div>`}</div>
      <div class="panel"><h2>What changes</h2>${diffRows(f.prompt_rows)}
        ${cfgChanged.length ? `<h3 style="margin:16px 0 8px">Configuration</h3>${diffRows(cfgChanged)}` : ''}</div>
      <div class="panel"><div class="panel-head"><h2>Offline validation</h2>
        <div class="actions"><select id="vn">${[300, 600, 1200, 2400].map(n => `<option ${n === 600 ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <select id="vs" title="Simulated-customer error rate">${[0, 0.05, 0.1, 0.2].map(x => `<option value="${x}">${x ? pct(x, 0) + ' sim error' : 'No sim error'}</option>`).join('')}</select>
        <button class="btn sm primary" data-act="validate" data-busy="Replaying…">Run validation</button></div></div>
        <div id="val">${validationHTML(f.validation)}</div></div>
    </div><div>
      <div class="panel"><h2>Delivery</h2><p class="small muted">${esc(f.agent.name)} · ${esc(f.agent.integration)}</p>
        <div class="stack">${methods.map(([m, l]) => `<button class="btn" style="width:100%;justify-content:center" data-act="deliver" data-m="${m}">${l}</button>`).join('')}</div>
        <div id="deliv" style="margin-top:12px">${f.pr ? `<div class="small"><b>Open pull request:</b> ${ext(f.pr.pr_url, `${esc(S.boot.git.repo)}#${f.pr.pr_number}`)} · branch ${ext(f.pr.branch_url, esc(f.pr.branch), 'mono')}</div>` : ''}</div></div>
      <div class="panel"><h2>Rollout plan</h2><ol class="small" style="padding-left:18px;margin:0">
        <li>Shadow traffic, 48 hours</li><li>Canary 5% → 25% → 50%</li><li>Full rollout</li></ol>
        <p class="small muted" style="margin-top:8px">Auto-rollback if resolution drops more than 1 pt or policy violations rise.</p></div>
      <div class="panel"><h2>Approval</h2>${f.approval ? `<p>In approval as <a href="#/approvals/${f.approval}">${f.approval}</a>.</p>`
        : `<p class="small muted">Routes by change type: ${esc(f.layer)} changes follow the approval policy.</p><button class="btn primary" data-act="toappr" data-busy="Routing…">Send to approvals</button>`}</div>
    </div></div>`);
  if (rw) rw.init();
  ACT.validate = btn => busy(btn, async () => { const r = await post(`/api/fix/${bid}/${fid}/validate`, { n: +$('#vn').value, sim_error: +$('#vs').value }); $('#val').innerHTML = validationHTML(r.validation); toast('Validation complete'); });
  ACT.deliver = el => busy(el, async () => {
    const r = await post(`/api/fix/${bid}/${fid}/deliver`, { method: el.dataset.m });
    if (r.patch) { $('#deliv').innerHTML = prHTML(r); if (r.live) toast(r.pr_reused ? `PR #${r.pr_number} updated` : `PR #${r.pr_number} opened`); return; }
    $('#deliv').innerHTML = `<div class="small" style="margin-bottom:6px"><b>${esc(r.method)}</b> artifact generated · logged to audit</div><pre class="code">${esc(JSON.stringify(r.spec || r.payload || r.request || r.overlay, null, 2))}</pre>`;
  });
  ACT.toappr = btn => busy(btn, async () => { const a = await post(`/api/fix/${bid}/${fid}/approve-request`); toast(`${a.id} routed to ${a.approvers.map(x => x.role).join(', ')}`); refreshBoot(); location.hash = `#/approvals/${a.id}`; });
}
const ext = (href, label, cls = '') => `<a href="${esc(href)}" target="_blank" rel="noopener" class="${cls}">${label}</a>`;
function prHTML(r) {
  const links = r.live
    ? `<div class="kv small"><span class="k">Pull request</span><span>${ext(r.pr_url, `#${r.pr_number} ${esc(r.title)}`)}</span>
        <span class="k">Branch</span><span>${ext(r.branch_url, esc(r.branch), 'mono')}</span>
        <span class="k">Commits</span><span>${r.commits.length ? r.commits.map(c => `${ext(c.url, c.short, 'mono')} ${esc(c.message)}`).join('<br>') : 'No new commits: branch already up to date'}</span>
        <span class="k">Files</span><span>${r.files.map(f => ext(r.file_urls[f], esc(f), 'mono')).join('<br>')}</span></div>`
    : `<div class="alert warn small" style="margin-bottom:8px"><div>${esc(r.note)}</div></div>
       <div class="kv small"><span class="k">Repository</span><span>${ext(r.repo_url, esc(r.repo), 'mono')}</span>
        <span class="k">Branch</span><span class="mono">${esc(r.branch)} <span class="faint">(from ${esc(r.base)})</span></span>
        <span class="k">Files</span><span class="mono">${r.files.map(esc).join('<br>')}</span>
        <span class="k">After pushing</span><span>${ext(r.compare_url, 'Open the compare view')}</span></div>
       <h3 style="margin:12px 0 6px">Do it by hand</h3><pre class="code">${esc(r.commands)}</pre>`;
  return `<div class="small" style="margin-bottom:6px"><b>${r.live ? (r.pr_reused ? 'Pull request updated' : 'Pull request opened') : 'Pull request prepared'}</b> on ${ext(r.repo_url, esc(r.repo))} · logged to audit</div>
    ${links}<h3 style="margin:12px 0 6px">Diff</h3><pre class="code">${diffColor(r.patch)}</pre>`;
}
const diffColor = t => esc(t).split('\n').map(l => l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@') ? `<span class="hdr">${l}</span>` : l.startsWith('+') ? `<span class="add">${l}</span>` : l.startsWith('-') ? `<span class="del">${l}</span>` : l).join('\n');

/* ------------------------------------------------------------------ approvals */
async function vApprovals() {
  crumbs([['Approvals']]);
  const d = await api('/api/approvals');
  const items = d.items.slice().sort((a, b) => (a.status === 'Waiting' ? 0 : 1) - (b.status === 'Waiting' ? 0 : 1));
  page(`${head('Approvals', 'Changes route to approvers by change type. Nothing ships without the required sign-offs and a passing regression gate.')}
    ${kpis([{ v: d.waiting, l: 'Waiting for a decision' }, { v: d.median_days != null ? `${d.median_days} d` : '—', l: 'Median time to decision' },
      { v: d.rolled_back_30d, l: 'Rolled back, last 30 days' }, { v: items.filter(a => a.status === 'Live').length, l: 'Live changes' }])}
    <div class="panel"><table><tr><th>Request</th><th>Change</th><th>Agent</th><th>Type</th><th>Risk</th><th>Waiting on</th><th class="num">Age</th><th>Status</th></tr>
    ${items.map(a => `<tr class="click" data-href="#/approvals/${a.id}"><td class="mono">${a.id}</td><td>${esc(a.title)}</td><td class="small">${esc(a.agent_name)}</td><td class="small">${esc(a.change_type)}</td>
      <td>${esc(a.risk)}</td><td>${esc(a.waiting_on || '—')}</td><td class="num">${a.age_days} d</td><td>${status(a.status)}</td></tr>`).join('')}</table></div>
    <div class="panel"><h2>Approval policy</h2><table><tr><th>Change type</th><th>Approvers</th><th>Rollout</th></tr>
      ${d.policy.map(p => `<tr><td>${esc(p.type)}</td><td>${p.approvers.map(esc).join(', ')}</td><td>${esc(p.rollout)}</td></tr>`).join('')}</table></div>`);
}

async function vApproval(cid) {
  const a = await api(`/api/approval/${cid}`);
  crumbs([['Approvals', '#/approvals'], [a.id]]);
  const pending = a.approvers.filter(x => x.status === 'Pending');
  const rw = replayWidget('rpa', { base: a.base_id, cand: a.harness_id });
  const ro = a.rollout;
  page(`${head(`${a.id} · ${esc(a.title)}`, `${status(a.status)} · ${esc(a.agent_name)} · ${esc(a.change_type)} · ${esc(a.risk)} risk`)}
    <div class="grid-main"><div>
      ${ro ? `<div class="panel"><div class="panel-head"><h2>Rollout</h2>${['Approved', 'Rolling out'].includes(a.status) ? '<button class="btn primary" data-act="advance" data-busy="Running stage…">Advance to next stage</button>' : ''}</div>
        <div class="stages">${ro.stages.map(s => `<div class="stage ${s.status.split(' ')[0]}"><b>${esc(s.name)}</b><div>${status(s.status)}</div>
          ${s.metrics ? `<div class="n">n=${s.metrics.n} · resolution <span class="${cls(s.metrics.delta)}">${pts(s.metrics.delta)}</span><br>violations ${pct(s.metrics.viol_cand, 2)}</div>` : ''}</div>`).join('')}</div></div>` : ''}
      <div class="panel"><div class="panel-head"><h2>What reviewers see: before and after</h2></div>${rw.html}</div>
      <div class="panel"><h2>Change</h2><ul style="padding-left:18px;margin:0">${a.edit_labels.map(l => `<li>${esc(l)}</li>`).join('') || '<li class="muted">No harness edits recorded</li>'}</ul>
        <div class="chips" style="margin-top:12px">${(a.layers || []).map(l => `<span class="badge purple">${esc(l)}</span>`).join('')}</div></div>
    </div><div>
      <div class="panel"><h2>Approvers</h2>${a.approvers.map(x => `<div class="approver"><div>${esc(x.role)}<div class="small muted">${x.by ? `${esc(x.by)} · ${esc(x.at)}` : 'Not yet reviewed'}</div></div>${status(x.status)}</div>`).join('')}
        ${pending.length && a.status === 'Waiting' ? `<div style="margin-top:14px" class="stack"><label class="field">Acting as<select id="role">${pending.map(x => `<option>${esc(x.role)}</option>`).join('')}</select></label>
          <p class="small muted">Agent-owner approvals are recorded as <b>${esc(S.boot?.settings?.approval_owner_name || 'Agent owner')}</b>.</p>
          <textarea id="cmt" placeholder="Comment (optional)"></textarea>
          <div class="actions"><button class="btn primary" data-act="dec" data-d="approve">Approve</button><button class="btn" data-act="dec" data-d="changes">Request changes</button><button class="btn danger" data-act="dec" data-d="reject">Reject</button></div></div>` : ''}</div>
      <div class="panel"><h2>Automated checks</h2><div class="kv">
        <span class="k">Regression</span><span>${esc(a.checks.regression || '—')}</span><span class="k">Frozen lines</span><span>${esc(a.checks.frozen || '—')}</span>
        <span class="k">Judge health</span><span>${esc(a.checks.judge || '—')}</span><span class="k">Rollout</span><span>${esc(a.rollout_plan)}</span></div></div>
      ${a.comments.length ? `<div class="panel"><h2>Comments</h2>${a.comments.map(c => `<p><b>${esc(c.by)}</b> <span class="faint small">${esc(c.at)}</span><br>${esc(c.text)}</p>`).join('')}</div>` : ''}
    </div></div>`);
  rw.init();
  ACT.dec = el => busy(el, async () => {
    const role = $('#role').value;
    const actor = role === 'Agent owner' ? (S.boot?.settings?.approval_owner_name || 'Agent owner') : role;
    await post(`/api/approval/${cid}/decide`, { role, decision: el.dataset.d, comment: $('#cmt').value, actor });
    toast('Decision recorded'); refreshBoot(); route();
  });
  ACT.advance = btn => busy(btn, async () => { const r = await post(`/api/approval/${cid}/advance`); toast(r.status === 'Rolled back' ? 'Auto-rollback: guardrail metric breached' : r.status === 'Live' ? 'Promoted to production' : 'Stage passed'); route(); });
}

/* ------------------------------------------------------------------ git change evidence */
async function vGitDelta() {
  crumbs([[NAV_GROUP('gitdelta')], ['Nightly versions & Git evidence']]);
  const d = await api('/api/vcs/change-evidence');
  page(`${head('Nightly versions & Git evidence', 'Overnight Plan-B trace batches mapped to Plane-A harness promotions, owner approval, and Git code diffs.',
    `${ext(d.repo.url, esc(d.repo.repo), 'btn')}<a class="btn" href="#/vcs">Open Version control</a><a class="btn" href="/api/vcs/change-evidence/export">Export customer report</a>`)}
    <div class="panel"><div class="panel-head"><h2>Overnight batch versioning</h2><span class="small muted">Owner: ${esc(d.owner_name)}</span></div>
      <table><tr><th>Batch</th><th>SemVer</th><th>Tag / Branch</th><th class="num">Traces</th><th>Approval</th><th>Mapping</th><th>Status</th></tr>
        ${d.batches.map(b => `<tr><td class="mono">run-${b.run_id}<div class="small faint">${esc((b.finished_at || b.started_at || '').replace('T', ' ').replace('Z', ' UTC'))}</div></td>
          <td class="mono">${esc(b.version.semver)}</td>
          <td class="small"><span class="mono">${esc(b.version.tag)}</span><div class="mono faint">${esc(b.version.branch)}</div></td>
          <td class="num">${num(b.traces)}</td>
          <td class="small">${b.approval ? `<a href="#/approvals/${b.approval.id}">${esc(b.approval.id)}</a> · ${b.approval.owner_approved ? `<span class="pos">${esc(b.approval.owner_name)} approved</span>` : '<span class="neg">owner pending</span>'}` : '<span class="faint">none linked</span>'}</td>
          <td class="small"><span class="badge ${b.mapping?.source === 'ambiguous-timestamp' ? 'warn' : b.mapping?.source === 'unmapped' ? '' : 'good'}">${esc(b.mapping?.source || 'unmapped')}</span></td>
          <td>${status(b.status === 'ok' ? 'Validated' : b.status || 'Unknown')}</td></tr>`).join('')}
      </table></div>
    <div class="panel"><div class="panel-head"><h2>Most relevant Git code sections</h2><span class="small muted">Recent commits on ${esc(d.repo.base)}</span></div>
      ${d.commits.map(c => `<div style="border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:12px">
        <div class="small"><b>${ext(c.url, esc(c.short), 'mono')}</b> ${esc(c.message)}<span class="faint"> · ${esc(c.author || 'unknown')} · ${esc(c.date || 'n/a')}</span></div>
        ${c.files.map(f => `<div style="margin-top:10px"><div class="small"><b>${ext(f.url, esc(f.path), 'mono')}</b> <span class="faint">${esc(f.status || '')} · +${num(f.additions)} / -${num(f.deletions)}</span></div>
          ${f.snippet ? `<pre class="code" style="max-height:170px">${esc(f.snippet)}</pre>` : '<div class="small faint">No patch snippet published by GitHub for this file.</div>'}</div>`).join('')}
      </div>`).join('') || empty('No commit evidence available right now.')}
    </div>`);
}

/* ------------------------------------------------------------------ experiments */
async function vExperiments() {
  crumbs([['Experiments']]);
  const [ex, cands] = await Promise.all([api(`/api/experiments?agent=${S.agent}`), api(`/api/candidates/${S.agent}`)]);
  const prodId = (cands.find(c => c.production) || {}).id;
  page(`${head('Experiments', 'Candidates compared on the same held-out scenarios with the same evaluators: paired bootstrap confidence intervals, Holm correction across candidates.')}
    <div class="panel"><table><tr><th>Experiment</th><th>Name</th><th class="num">Candidates</th><th class="num">Scenarios</th><th class="num">Seeds</th><th>Recommended</th><th>Run</th></tr>
      ${ex.length ? ex.slice().reverse().map(e => `<tr class="click" data-href="#/experiments/${e.id}"><td class="mono">${e.id}</td><td>${esc(e.name)}</td><td class="num">${e.candidates.length}</td><td class="num">${num(e.n)}</td>
        <td class="num">${e.seeds}</td><td class="mono small">${esc(e.recommended || '—')}</td><td class="small">${esc(e.created)}</td></tr>`).join('') : `<tr><td colspan="7">${empty('No experiments yet.')}</td></tr>`}</table></div>
    ${cands.length ? `<div class="panel"><h2>New experiment</h2><p class="small muted">The first selected harness is the baseline. Candidates found by the optimizer or RL trainer appear here automatically.</p>
      <div class="table-wrap"><table><tr><th></th><th>Harness</th><th>Changes vs production</th></tr>
      ${cands.map(c => `<tr><td><input type="checkbox" class="cand" value="${esc(c.id)}" ${c.id === prodId ? 'checked' : ''}></td><td>${esc(c.name)} ${c.production ? '<span class="badge good">production</span>' : ''} ${c.has_adapter ? '<span class="badge purple">adapter</span>' : ''}<div class="small mono faint">${esc(c.id)}</div></td>
        <td class="small">${c.edits_vs_prod.map(esc).join('<br>') || '—'}</td></tr>`).join('')}</table></div>
      <div class="form-grid" style="margin-top:14px"><label class="field">Held-out scenarios<select id="xn">${[400, 800, 1200, 2400].map(n => `<option ${n === 1200 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="field">Sampling seeds<select id="xs">${[1, 2, 3, 5].map(n => `<option ${n === 3 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="field">Simulated-customer error<select id="xe">${[0, 0.05, 0.1, 0.2].map(x => `<option value="${x}">${pct(x, 0)}</option>`).join('')}</select></label>
        <label class="field">Name<input type="text" id="xname" placeholder="Experiment name"></label></div>
      <button class="btn primary" data-act="runexp" data-busy="Running experiment…">Run experiment</button></div>` : ''}`);
  ACT.runexp = btn => busy(btn, async () => {
    const ids = $$('.cand:checked').map(c => c.value);
    const ordered = [prodId, ...ids.filter(i => i !== prodId)].filter(i => ids.includes(i));
    if (ordered.length < 2) throw new Error('Pick a baseline and at least one candidate.');
    const e = await post('/api/experiments', { agent: S.agent, candidates: ordered, n: +$('#xn').value, seeds: +$('#xs').value, sim_error: +$('#xe').value, name: $('#xname').value || undefined });
    location.hash = `#/experiments/${e.id}`;
  });
}

const COLORS = ['#9A9A9A', '#000000', '#EE0000', '#555555', '#A30000', '#00752F', '#A36A00'];
async function vExperiment(eid) {
  const e = await api(`/api/experiment/${eid}`);
  crumbs([['Experiments', '#/experiments'], [e.id]]);
  const base = e.results[0];
  const rec = e.results.find(r => r.id === e.recommended);
  const rw = replayWidget('rpx', { base: base.id, cand: (rec || e.results[1]).id, theme: e.theme_id });
  page(`${head(`${e.id} · ${esc(e.name)}`, `${num(e.n)} held-out scenarios × ${e.seeds} seed${e.seeds > 1 ? 's' : ''} · baseline ${esc(base.name)}${e.sim_error ? ` · simulator error ${pct(e.sim_error, 0)}` : ''}${e.optimizer ? ` · optimizer explored ${e.optimizer.explored} candidates, ${pct(e.optimizer.budget_used, 0)} of budget` : ''}`)}
    ${rec ? `<div class="alert info"><div><b>Recommended: ${esc(rec.name)}.</b> Best reward among significant, policy-safe, harness-only candidates. Weight changes go through the separate model-risk path.</div>
      <button class="btn primary sm" data-act="promote" data-c="${esc(rec.id)}" data-busy="Routing…">Send to approvals</button></div>` : ''}
    <div class="panel table-wrap"><table><tr><th>Candidate</th><th class="num">Resolution (judge)</th><th class="num">Lift, 95% CI</th><th class="num">Holm p</th><th class="num">Human audit</th><th class="num">Violations</th><th class="num">Tokens</th><th class="num">P95</th><th class="num">Reward</th><th></th></tr>
      ${e.results.map((r, i) => { const m = r.metrics; return `<tr class="${r.id === e.recommended ? 'hl' : ''}"><td><span class="dot" style="background:${COLORS[i % 7]}"></span>${esc(r.name)}<div class="small faint">${esc(r.note || '')}${e.seeds > 1 ? ` · per-seed ${m.seed_res.map(x => pct(x)).join(', ')}` : ''}</div></td>
        <td class="num">${pct(m.resolution)}</td><td class="num">${r.lift ? `<span class="${cls(r.lift.diff)}">${pts(r.lift.diff)}</span><div class="small faint">${pts(r.lift.lo)} to ${pts(r.lift.hi)}</div>` : '<span class="faint">baseline</span>'}</td>
        <td class="num">${r.lift ? `${fx(r.lift.p_holm, 3)} ${r.significant ? '<span class="badge good">sig.</span>' : ''}` : ''}</td>
        <td class="num">${pct(m.gold)}${r.audit ? `<div class="small faint">${r.audit.confirmed}/${r.audit.sampled} judged-resolved confirmed</div>` : `<div class="small faint">${e.base_audit.confirmed}/${e.base_audit.sampled} confirmed</div>`}</td>
        <td class="num">${pct(m.violations, 2)}</td><td class="num">${num(m.tokens)}</td><td class="num">${fx(m.p95, 1)} s</td><td class="num">${fx(m.reward, 3)}</td>
        <td>${i ? `<button class="btn sm ghost" data-act="cmp" data-c="${esc(r.id)}">Compare</button>` : ''}</td></tr>`; }).join('')}</table></div>
    <div class="grid-2">
      <div class="panel"><h2>Quality against cost</h2>${scatter({ points: e.results.map((r, i) => ({ x: r.metrics.tokens, y: r.metrics.resolution, label: r.name.split(':')[0], color: COLORS[i % 7] })), xLabel: 'Tokens per task', yLabel: 'Resolution (judge)' })}</div>
      <div class="panel"><h2>Reward-hacking check</h2><p class="small muted">Judge lift should match the human-audited lift. A gap, or a jump in detailed closing summaries (which the judge over-rewards), means the candidate is optimizing the judge rather than the outcome.</p>
        <table><tr><th>Candidate</th><th class="num">Judge lift</th><th class="num">Audit lift</th><th class="num">Detailed summaries</th></tr>
        ${e.results.map(r => { const gap = r.lift ? r.lift.diff - r.gold_lift.diff : 0; const hack = r.metrics.detailed - base.metrics.detailed > 0.15 || gap > 0.03;
          return `<tr><td>${esc(r.name.split(':')[0])}</td><td class="num">${r.lift ? pts(r.lift.diff) : '—'}</td><td class="num">${r.gold_lift ? pts(r.gold_lift.diff) : '—'}</td><td class="num">${pct(r.metrics.detailed, 0)} ${hack ? '<span class="badge bad">check</span>' : ''}</td></tr>`; }).join('')}</table></div>
    </div>
    <div class="panel"><div class="panel-head"><h2>Before and after</h2><select id="cmpsel" data-change="cmpsel">${e.results.slice(1).map(r => `<option value="${esc(r.id)}" ${r.id === (rec || e.results[1]).id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div><div id="rpx-wrap">${rw.html}</div></div>`);
  rw.init();
  const swap = id => { const w = replayWidget('rpx', { base: base.id, cand: id, theme: e.theme_id }); $('#rpx-wrap').innerHTML = w.html; w.init(); $('#cmpsel').value = id; };
  ACT.cmpsel = el => swap(el.value);
  ACT.cmp = el => { swap(el.dataset.c); $('#rpx-wrap').scrollIntoView({ behavior: 'smooth' }); };
  ACT.promote = btn => busy(btn, async () => { const a = await post(`/api/experiment/${eid}/promote`, { candidate: btn.dataset.c }); refreshBoot(); location.hash = `#/approvals/${a.id}`; });
}

/* ------------------------------------------------------------------ optimizer & RL */
async function vOptimizer() {
  crumbs([['Optimizer & RL']]);
  const a = S.boot.agents.find(x => x.id === S.agent);
  if (!a.kind) { page(head('Optimizer & RL') + observeOnly(a)); return; }
  const cands = await api(`/api/candidates/${S.agent}`);
  const tab = S.query.get('tab') || 'search';
  const opts = cands.map(c => `<option value="${esc(c.id)}" ${c.production ? 'selected' : ''}>${esc(c.name)}${c.production ? ' (production)' : ''}</option>`).join('');
  const rlOK = a.level === '1p_repo';
  const f = (id, label, v, extra = '') => `<label class="field">${label}<input type="number" id="${id}" value="${v}" ${extra}></label>`;
  page(`${head('Optimizer & RL', 'Two ways to improve the agent from AI feedback: search over the harness (prompt, tools, gates), or fine-tune an adapter on the policy with reinforcement learning.')}
    <div class="tabs"><button class="${tab === 'search' ? 'on' : ''}" data-act="tab" data-t="search">Harness search</button><button class="${tab === 'rl' ? 'on' : ''}" data-act="tab" data-t="rl">RL fine-tune</button></div>
    <div class="grid-main"><div>
    ${tab === 'search' ? `<div class="panel"><h2>Reflective harness search</h2>
      <p class="small muted">GEPA-style loop: reflect on failing minibatch traces → propose one edit → minibatch filter → full evaluation → Pareto pool by scenario → occasional merge. Winner is chosen on a fresh split with Holm correction, then confirmed once on a third split. Frozen policy lines are never edited.</p>
      <div class="form-grid"><label class="field">Start from<select id="o_base">${opts}</select></label>
        ${f('o_budget', 'Rollout budget', 6000, 'step="1000" min="1000"')}${f('o_mb', 'Minibatch size', 40, 'min="10"')}${f('o_nopt', 'Optimization split', 200)}${f('o_nsel', 'Selection split', 300)}${f('o_nconf', 'Confirmation split', 600)}
        ${f('o_wres', 'Weight: resolution', 1.0, 'step="0.1"')}${f('o_wtok', 'Weight: tokens', 0.15, 'step="0.05"')}${f('o_wlat', 'Weight: latency', 0.05, 'step="0.05"')}${f('o_wemp', 'Weight: empathy', 0.0, 'step="0.1"')}
        ${f('o_eps', 'Exploration rate', 0.2, 'step="0.05" min="0" max="1"')}${f('o_topk', 'Finalists', 3, 'min="1" max="6"')}${f('o_seed', 'Seed', 1)}
        <label class="field">Simulated-customer error<select id="o_sim">${[0, 0.05, 0.1, 0.2].map(x => `<option value="${x}">${pct(x, 0)}</option>`).join('')}</select></label>
        <label class="field">Policy violations<select id="o_mode"><option value="constraint">Hard constraint</option><option value="penalty">Penalty in reward</option></select></label></div>
      <div class="actions" style="margin-bottom:14px"><label class="check"><input type="checkbox" id="o_merge" checked> Merge frontier candidates</label>
        <label class="check"><input type="checkbox" id="o_llm" ${S.boot.llm ? '' : 'disabled'}> LLM reflective proposer ${S.boot.llm ? '' : '<span class="faint small">(set ANTHROPIC_API_KEY)</span>'}</label></div>
      <button class="btn primary" data-act="runopt" data-busy="Starting…">Run optimizer</button></div>`
    : `<div class="panel"><h2>RL fine-tune on AI feedback</h2>
      ${rlOK ? '' : '<div class="alert warn">Weight changes need a first-party agent with repo access. Switch to the billing agent to run RL.</div>'}
      <p class="small muted">Trains an adapter on the agent's decision logits (the simulator's stand-in for a LoRA adapter) with a KL penalty to the reference policy. The AI judge has a verbosity bias, so watch the gap between judged and human-audited resolution.</p>
      <div class="form-grid"><label class="field">Reference harness<select id="r_base">${opts}</select></label>
        <label class="field">Algorithm<select id="r_algo"><option value="grpo">GRPO (group-relative)</option><option value="reinforce">REINFORCE + baseline</option><option value="dpo">DPO from AI preferences</option></select></label>
        <label class="field">Reward source<select id="r_src"><option value="judge">AI judge (RLAIF)</option><option value="verifiable">Verifiable end-state</option><option value="gold">Human labels (oracle)</option></select></label>
        ${f('r_iters', 'Iterations', 30, 'min="1" max="200"')}${f('r_batch', 'Prompts per iteration', 12)}${f('r_group', 'Group size (GRPO)', 4)}
        ${f('r_lr', 'Learning rate', 0.5, 'step="0.1"')}${f('r_kl', 'KL coefficient', 0.05, 'step="0.01"')}${f('r_beta', 'DPO β', 0.5, 'step="0.1"')}
        ${f('r_wtok', 'Weight: tokens', 0.05, 'step="0.05"')}${f('r_pb', 'Judge position bias', 0.08, 'step="0.02"')}${f('r_seed', 'Seed', 1)}
        <label class="field">Policy violations<select id="r_mode"><option value="constraint">Hard constraint</option><option value="penalty">Penalty in reward</option></select></label></div>
      <div class="actions" style="margin-bottom:14px"><label class="check"><input type="checkbox" id="r_swap" checked> Swap positions in pairwise judging (DPO)</label></div>
      <button class="btn primary" data-act="runrl" data-busy="Starting…" ${rlOK ? '' : 'disabled'}>Start training</button></div>`}
      <div id="jobview"></div>
    </div><div>
      <div class="panel"><h2>Recent runs</h2><div id="joblist" class="small muted">Loading…</div></div>
    </div></div>`);
  const v = id => +$(`#${id}`).value;
  ACT.tab = el => { location.hash = `#/optimizer?tab=${el.dataset.t}`; };
  ACT.runopt = btn => busy(btn, async () => {
    const j = await post('/api/optimizer/run', { agent: S.agent, base_id: $('#o_base').value, budget: v('o_budget'), minibatch: v('o_mb'), n_opt: v('o_nopt'), n_sel: v('o_nsel'), n_conf: v('o_nconf'),
      weights: { resolution: v('o_wres'), tokens: v('o_wtok'), latency: v('o_wlat'), empathy: v('o_wemp') }, epsilon: v('o_eps'), top_k: v('o_topk'), seed: v('o_seed'),
      sim_error: v('o_sim'), policy_mode: $('#o_mode').value, merge: $('#o_merge').checked, use_llm: $('#o_llm').checked });
    watchJob(j.id);
  });
  ACT.runrl = btn => busy(btn, async () => {
    const j = await post('/api/rl/run', { agent: S.agent, base_id: $('#r_base').value, algorithm: $('#r_algo').value, reward_source: $('#r_src').value, iterations: v('r_iters'),
      batch: v('r_batch'), group: v('r_group'), lr: v('r_lr'), kl_coef: v('r_kl'), beta: v('r_beta'), weights: { tokens: v('r_wtok') }, position_bias: v('r_pb'),
      swap_positions: $('#r_swap').checked, policy_mode: $('#r_mode').value, seed: v('r_seed') });
    watchJob(j.id);
  });
  ACT.openjob = el => watchJob(el.dataset.j);
  ACT.canceljob = el => post(`/api/jobs/${el.dataset.j}/cancel`).then(() => toast('Cancelling…'));
  ACT.jobexp = btn => busy(btn, async () => {
    const e = await post('/api/experiments', { agent: S.agent, candidates: [btn.dataset.base, btn.dataset.cand], n: 1200, seeds: 2, name: `Run ${btn.dataset.job}: ${btn.dataset.cand}` });
    location.hash = `#/experiments/${e.id}`;
  });
  ACT.jobcmp = el => { const w = replayWidget('rpj', { base: el.dataset.base, cand: el.dataset.cand }); $('#jobreplay').innerHTML = w.html; w.init(); $('#jobreplay').scrollIntoView({ behavior: 'smooth' }); };
  const list = async () => {
    const js = await api('/api/jobs');
    const el = $('#joblist'); if (!el) return;
    el.innerHTML = js.length ? js.map(j => `<div class="approver"><div><a href="#" data-act="openjob" data-j="${j.id}">${j.id}</a> · ${j.kind === 'rl' ? `RL ${esc((j.params.algorithm || 'grpo').toUpperCase())}` : 'Harness search'}<div class="faint">${j.params.agent} · ${j.elapsed}s</div></div>${status(j.status)}</div>`).join('') : 'No runs yet in this session.';
  };
  list(); S.timers.push(setInterval(list, 3000));
  const last = S.jobs[`${S.agent}:${tab}`]; if (last) watchJob(last);
}

function watchJob(id) {
  const tick = async () => {
    let j; try { j = await api(`/api/jobs/${id}`); } catch (e) { return; }
    S.jobs[`${j.params.agent}:${j.kind === 'rl' ? 'rl' : 'search'}`] = id;
    const el = $('#jobview'); if (!el) return;
    const keepReplay = $('#jobreplay')?.innerHTML || '';
    el.innerHTML = renderJob(j) + `<div id="jobreplay">${keepReplay}</div>`;
    if (j.status !== 'running') clearInterval(S.jobTimer);
  };
  clearInterval(S.jobTimer);
  tick(); S.jobTimer = setInterval(tick, 1000);
}

function renderJob(j) {
  const head_ = `<div class="panel-head"><h2>${j.id} · ${j.kind === 'rl' ? 'RL fine-tune' : 'Harness search'}</h2><div class="actions">${status(j.status)}${j.status === 'running' ? `<button class="btn sm" data-act="canceljob" data-j="${j.id}">Cancel</button>` : ''}</div></div>
    <div class="progress"><span style="width:${j.progress * 100}%"></span></div><div class="small muted" style="margin:6px 0 12px">${pct(j.progress, 0)} · ${j.elapsed}s${j.error ? ` · <span class="neg">${esc(j.error)}</span>` : ''}</div>`;
  const log = `<div class="log" aria-live="polite">${j.logs.slice(-60).map(l => `<div><span class="t">${fx(l.t, 1)}s</span>${esc(l.msg)}</div>`).join('')}</div>`;
  return `<div class="panel">${head_}${j.kind === 'rl' ? rlBody(j) : optBody(j)}<h3 style="margin:16px 0 8px">Log</h3>${log}</div>`;
}

function optBody(j) {
  const snap = j.result || j.snapshot;
  if (!snap) return '';
  const pool = snap.pool.slice().sort((a, b) => b.reward - a.reward);
  let out = `<div class="kv" style="margin-bottom:12px"><span class="k">Rollouts used</span><span>${num(snap.used)} of ${num(snap.budget)}</span><span class="k">Candidates explored</span><span>${snap.explored} (${snap.rejected.length} rejected at minibatch)</span></div>
    <div class="table-wrap"><table><tr><th>Candidate</th><th>Parent</th><th>Edits from production</th><th class="num">Reward</th><th class="num">Judge</th><th class="num">Human audit</th><th class="num">Tokens</th><th>Frontier</th></tr>
    ${pool.slice(0, 12).map(c => `<tr><td class="mono">${c.id}</td><td class="mono faint">${c.parent || '—'}</td><td class="small">${c.edits.map(esc).join('<br>') || 'Seed'}${c.detailed > 0.4 ? ' <span class="badge bad">verbose</span>' : ''}</td>
      <td class="num">${fx(c.reward, 3)}</td><td class="num">${pct(c.resolution)}</td><td class="num">${pct(c.gold)}</td><td class="num">${num(c.tokens)}</td><td>${c.frontier ? '<span class="badge good">Pareto</span>' : ''}</td></tr>`).join('')}</table></div>`;
  if (j.result) {
    const r = j.result;
    if (r.selection.length) out += `<h3 style="margin:16px 0 8px">Selection on a fresh split</h3><table><tr><th>Finalist</th><th class="num">Reward</th><th class="num">Lift</th><th class="num">p</th><th class="num">Holm p</th></tr>
      ${r.selection.map(s => `<tr class="${r.best && s.id === r.best.id ? 'hl' : ''}"><td class="mono">${s.id}</td><td class="num">${fx(s.reward, 3)}</td><td class="num ${cls(s.lift)}">${sign(s.lift, 3)}</td><td class="num">${fx(s.p, 3)}</td><td class="num">${fx(s.p_holm, 3)}</td></tr>`).join('')}</table>`;
    if (r.best && r.confirmation) {
      const c = r.confirmation, gap = c.resolution.diff - c.gold.diff;
      out += `<div class="alert ${gap > 0.02 ? 'warn' : 'info'}" style="margin-top:14px"><div><b>${esc(r.best.name)}</b> confirmed on ${num(c.n)} new scenarios: judge ${pts(c.resolution.diff)} (${pts(c.resolution.lo)} to ${pts(c.resolution.hi)}), human audit ${pts(c.gold.diff)}, tokens ${sign(100 * (c.cand.tokens - c.base.tokens) / c.base.tokens)}%.
        ${gap > 0.02 ? ' The judge lift exceeds the audited lift — inspect for reward hacking.' : ''}</div></div>
        <div class="actions"><button class="btn primary" data-act="jobexp" data-job="${j.id}" data-base="${esc(j.params.base_id)}" data-cand="${esc(r.best.id)}" data-busy="Running experiment…">Run as experiment</button>
        <button class="btn" data-act="jobcmp" data-base="${esc(j.params.base_id)}" data-cand="${esc(r.best.id)}">Compare conversations</button></div>`;
    }
  }
  return out;
}

function rlBody(j) {
  const snap = j.result || j.snapshot;
  if (!snap) return '';
  const cv = snap.curve, held = snap.held;
  const heldAt = it => held.find(h => h.it === it);
  const labels = cv.map(p => p.it);
  let out = `<h3 style="margin-bottom:6px">Training signal vs held-out outcome</h3>${lineChart({
    series: [{ name: 'Train reward', color: '#000000', values: cv.map(p => p.reward) },
      { name: 'Held-out judge resolution', color: '#8A8A8A', values: labels.map(i => heldAt(i)?.resolution ?? null), dots: true },
      { name: 'Held-out human audit', color: '#EE0000', values: labels.map(i => heldAt(i)?.gold ?? null), dots: true, dash: '5 4' }],
    labels, yFmt: v => fx(v, 2), height: 230 })}
    <div class="grid-2" style="margin-top:10px"><div><h3 style="margin-bottom:6px">KL to reference</h3>${lineChart({ series: [{ name: 'KL', color: '#555555', values: cv.map(p => p.kl) }], labels, yFmt: v => fx(v, 3), yMin: 0, height: 150 })}</div>
    <div><h3 style="margin-bottom:6px">Detailed closing summaries</h3>${lineChart({ series: [{ name: 'Detailed', color: '#A30000', values: cv.map(p => p.detailed) }], labels, yMin: 0, height: 150 })}</div></div>`;
  if (j.result) {
    const r = j.result;
    if (r.warning) out += `<div class="alert warn" style="margin-top:12px">${esc(r.warning)}</div>`;
    out += `<h3 style="margin:16px 0 8px">Policy before and after training</h3><div class="table-wrap"><table><tr><th>Decision</th><th>Action</th><th class="num">Before</th><th class="num">After</th></tr>
      ${r.policy.map(d => d.actions.map((a, i) => `<tr>${i === 0 ? `<td rowspan="${d.actions.length}">${esc(d.label)}</td>` : ''}<td>${esc(a.label)}</td><td class="num">${pct(a.before)}</td><td class="num ${cls(a.after - a.before)}">${pct(a.after)}</td></tr>`).join('')).join('')}</table></div>
      <div class="actions" style="margin-top:14px"><span class="small">Registered as <b>${esc(r.candidate.name)}</b></span>
        <button class="btn primary" data-act="jobexp" data-job="${j.id}" data-base="${esc(j.params.base_id)}" data-cand="${esc(r.candidate.id)}" data-busy="Running experiment…">Run as experiment</button>
        <button class="btn" data-act="jobcmp" data-base="${esc(j.params.base_id)}" data-cand="${esc(r.candidate.id)}">Compare conversations</button></div>`;
  }
  return out;
}

/* ------------------------------------------------------------------ regression suites */
async function vRegression() {
  crumbs([['Regression suites']]);
  const a = S.boot.agents.find(x => x.id === S.agent);
  if (!a.kind) { page(head('Regression suites') + observeOnly(a)); return; }
  const [suites, themes, cands] = await Promise.all([api(`/api/suites?agent=${S.agent}`), api(`/api/themes/${S.agent}`), api(`/api/candidates/${S.agent}`)]);
  const su = await api(`/api/suite/${suites[0].id}`);
  const pre = S.query.get('theme');
  S.suiteRun = S.suiteRun && S.suiteRun.suite === su.id ? S.suiteRun : null;
  const res = S.suiteRun ? Object.fromEntries(S.suiteRun.results.map(r => [r.id, r.pass])) : {};
  page(`${head('Regression suites', 'Failure traces become permanent tests. Every harness change is replayed against the suite before it can ship.')}
    <div class="grid-main"><div>
      <div class="panel"><div class="panel-head"><div><h2 class="mono">${esc(su.name)}</h2><div class="small muted">${su.tests.length} tests · ${su.tests.filter(t => t.holdout).length} held out · ${esc(su.runs_in)}</div></div>
        <div class="actions"><select id="runh">${cands.map(c => `<option value="${esc(c.id)}" ${c.production ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <label class="check small"><input type="checkbox" id="runho"> Include holdout</label><button class="btn primary sm" data-act="runsuite" data-busy="Replaying suite…">Run suite</button></div></div>
        ${S.suiteRun ? `<div class="alert ${S.suiteRun.gate_ok ? 'info' : 'bad'}"><div><b>${S.suiteRun.gate_ok ? 'Gate passes' : 'Gate blocks release'}</b> for ${esc(S.suiteRun.name)}: ${S.suiteRun.passed}/${S.suiteRun.total} pass (${pct(S.suiteRun.rate)}), policy tests ${S.suiteRun.policy_ok ? 'all pass' : 'failing'}.</div></div>` : ''}
        <div class="table-wrap" style="max-height:560px;overflow:auto"><table><tr><th>Test</th><th>Scenario</th><th>Expected behaviour</th><th>Check</th><th>Flags</th><th>Result</th></tr>
        ${su.tests.slice().reverse().map(t => `<tr><td class="mono">${t.id}</td><td>${esc(t.scenario)}<div class="small faint">seed ${t.seed}</div></td><td>${esc(t.expected)}</td><td class="small">${esc(t.check)}</td>
          <td>${t.holdout ? '<span class="badge">holdout</span>' : ''}${t.synthetic ? '<span class="badge purple">synthetic</span>' : ''}${t.status === 'Draft' ? status('Draft') : ''}</td>
          <td>${t.id in res ? (res[t.id] ? '<span class="pos">Pass</span>' : '<span class="neg">Fail</span>') : '<span class="faint">—</span>'}</td></tr>`).join('')}</table></div></div>
    </div><div>
      <div class="panel"><h2>Release gate</h2>
        <label class="field">Minimum pass rate<input type="number" id="gmin" value="${su.gate.min_pass * 100}" min="50" max="100" step="1"></label>
        <label class="check" style="margin:10px 0"><input type="checkbox" id="gpol" ${su.gate.policy_all ? 'checked' : ''}> Every policy test must pass</label>
        <p class="small muted">Changing the gate requires AI Governance sign-off and is written to the audit log.</p>
        <button class="btn sm" data-act="gate">Save gate</button></div>
      <div class="panel" id="convert"><h2>Convert a theme to tests</h2>
        <label class="field">Failure theme<select id="cth">${themes.map(t => `<option value="${t.id}" ${t.id === pre ? 'selected' : ''}>${esc(t.name)} (${t.traces})</option>`).join('')}</select></label>
        <div class="form-grid" style="margin-top:10px"><label class="field">Maximum tests<input type="number" id="cmax" value="64" min="5" max="200"></label>
        <label class="field">Holdout share<input type="number" id="cho" value="20" min="0" max="50"></label></div>
        <label class="check"><input type="checkbox" id="csyn" checked> Add synthetic variations (20%)</label>
        <label class="check" style="margin:6px 0 12px"><input type="checkbox" id="cred" checked> Redact customer PII</label>
        <button class="btn primary sm" data-act="preview" data-busy="Deduplicating…">Preview tests</button>
        <div id="cprev" style="margin-top:12px"></div></div>
    </div></div>`);
  if (pre) $('#convert').scrollIntoView();
  ACT.runsuite = btn => busy(btn, async () => { S.suiteRun = { ...(await post(`/api/suite/${su.id}/run`, { harness_id: $('#runh').value, include_holdout: $('#runho').checked })), name: $('#runh').selectedOptions[0].textContent }; route(); });
  ACT.gate = () => post(`/api/suite/${su.id}/gate`, { min_pass: +$('#gmin').value / 100, policy_all: $('#gpol').checked }).then(() => toast('Gate saved · AI Governance sign-off requested'));
  const conv = commit => post(`/api/theme/${$('#cth').value}/convert`, { max_tests: +$('#cmax').value, holdout: +$('#cho').value / 100, synthetic: $('#csyn').checked, redact: $('#cred').checked, commit });
  ACT.preview = btn => busy(btn, async () => {
    const r = await conv(false);
    $('#cprev').innerHTML = `<p class="small">${r.evidence} evidence traces → <b>${r.tests.length} tests</b> (${r.tests.filter(t => t.synthetic).length} synthetic, ${r.tests.filter(t => t.holdout).length} holdout). They fail on production by construction and should pass once the fix ships.</p>
      <div style="max-height:220px;overflow:auto"><table>${r.tests.slice(0, 40).map(t => `<tr><td class="mono small">${t.id}</td><td class="small">${esc(t.expected)}</td></tr>`).join('')}</table></div>
      <button class="btn primary sm" style="margin-top:10px" data-act="commit" data-busy="Creating…">Create ${r.tests.length} tests</button>`;
  });
  ACT.commit = btn => busy(btn, async () => { const r = await conv(true); toast(`${r.tests.length} tests added to ${r.suite}`); S.suiteRun = null; route(); });
}

/* ------------------------------------------------------------------ evidence explorer */
async function vTraces() {
  crumbs([['Evidence explorer']]);
  const a = S.boot.agents.find(x => x.id === S.agent);
  if (!a.kind) { page(head('Evidence explorer') + observeOnly(a)); return; }
  const th = S.query.get('theme') || '', flt = S.query.get('filter') || 'flagged', off = +(S.query.get('offset') || 0);
  const [themes, d] = await Promise.all([api(`/api/themes/${S.agent}`), api(`/api/traces/${S.agent}?limit=50&offset=${off}${th ? `&theme=${th}` : ''}${flt !== 'all' ? `&filter=${flt}` : ''}`)]);
  const q = (k, v) => { const p = new URLSearchParams(S.query); p.set(k, v); if (k !== 'offset') p.delete('offset'); return `#/traces?${p}`; };
  page(`${head('Evidence explorer', 'Every production trace with its evaluator verdicts, outcome signals and span timeline.')}
    <div class="panel"><div class="actions" style="margin-bottom:12px">
      <select data-change="fth"><option value="">All themes</option>${themes.map(t => `<option value="${t.id}" ${t.id === th ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <div class="seg">${[['flagged', 'Flagged'], ['judge_fail', 'Judge fail'], ['repeat', 'Repeat contact'], ['unlabeled', 'Unlabeled'], ['all', 'All']].map(([k, l]) => `<button class="${k === flt ? 'on' : ''}" data-act="flt" data-f="${k}">${l}</button>`).join('')}</div>
      <span class="muted small">${num(d.total)} traces</span></div>
      ${traceTable(d.items)}
      <div class="actions" style="margin-top:12px;justify-content:flex-end">${off > 0 ? `<a class="btn sm" href="${q('offset', Math.max(0, off - 50))}">Newer</a>` : ''}${off + 50 < d.total ? `<a class="btn sm" href="${q('offset', off + 50)}">Older</a>` : ''}</div></div>`);
  ACT.fth = el => { location.hash = q('theme', el.value); };
  ACT.flt = el => { location.hash = q('filter', el.dataset.f); };
}

async function vTrace(tid) {
  const t = await api(`/api/trace/${tid}`);
  crumbs([['Evidence explorer', '#/traces'], [tid]]);
  const cands = await api(`/api/candidates/${t.agent}`);
  const ev = t.evaluators, res = ev.resolution;
  const total = Math.max(...t.spans.map(s => s.start + s.dur));
  const alt = cands.filter(c => c.id !== t.harness);
  page(`${head(`<span class="mono">${tid}</span>`, `${esc(t.label)} · ${esc(t.version)} · ${t.date} ${t.time}${t.theme_name ? ` · <a href="#/themes/${t.theme_id}">${esc(t.theme_name)}</a>` : ''}`,
    `<a class="btn sm primary" href="#/journey/${tid}">View journey</a><button class="btn sm" data-act="tosuite">Add to regression suite</button>`)}
    <div class="grid-main"><div>
      <div class="panel"><h2>Conversation</h2><div class="msgs" style="max-width:640px">${t.messages.map(m => msgHTML(m)).join('')}</div></div>
      <div class="panel"><h2>Span timeline</h2><div class="timeline">${t.spans.map(s => `<div class="span-row"><span class="mono small">${esc(s.name)}</span><div class="track"><span class="${s.kind}" style="left:${100 * s.start / total}%;width:${Math.max(0.8, 100 * s.dur / total)}%"></span></div><span class="num small">${fx(s.dur)} s</span></div>`).join('')}</div>
        <p class="small muted" style="margin-top:8px">${fx(t.latency, 1)} s agent time · ${num(t.tokens)} tokens</p></div>
      <div class="panel"><div class="panel-head"><h2>Replay with another harness</h2><select id="altsel" data-change="alt">${alt.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div><div id="trp"></div></div>
    </div><div>
      <div class="panel"><h2>Evaluators</h2>
        <div class="approver"><div>Resolution judge<div class="small muted">${esc(res.rationale)}</div></div>${res.pass ? '<span class="badge good">Pass</span>' : '<span class="badge bad">Fail</span>'}</div>
        ${Object.entries(res.criteria).map(([k, v]) => `<div class="small" style="padding:3px 0 3px 12px"><span class="dot ${v ? 'good' : 'bad'}"></span>${esc(S.boot.library.criteria[k])}</div>`).join('')}
        <div class="approver"><div>Policy adherence<div class="small muted">${esc(ev.policy.detail)}</div></div>${ev.policy.pass ? '<span class="badge good">Pass</span>' : '<span class="badge bad">Fail</span>'}</div>
        <div class="approver"><div>Tool-sequence check<div class="small muted">${esc(ev.tool_sequence.detail)}</div></div>${ev.tool_sequence.anomaly ? '<span class="badge bad">Anomaly</span>' : '<span class="badge good">OK</span>'}</div>
        <div class="approver"><div>Empathy and tone</div>${ev.empathy.pass ? '<span class="badge good">Pass</span>' : '<span class="badge bad">Fail</span>'}</div>
        <div class="approver"><div>Repeat contact 72h</div>${ev.outcome.repeat_contact ? `<span class="badge bad">${ev.outcome.repeat_hours} h</span>` : '<span class="badge good">None</span>'}</div>
        <div class="approver"><div>CSAT</div><span>${ev.outcome.csat}</span></div></div>
      <div class="panel"><h2>Human label</h2><p class="small muted">Labels feed the judge calibration set.</p>
        ${t.human ? `<p>Labeled: <b>${esc(t.human)}</b></p>` : ''}
        <div class="actions">${['Confirmed failure', 'Not a failure', 'Unsure'].map(v => `<button class="btn sm" data-act="label" data-v="${v}">${v}</button>`).join('')}</div></div>
      <div class="panel"><h2>Agent decisions</h2><table>${t.decisions.map(d => `<tr><td class="small">${esc(S.boot.decisions[d.d])}</td><td class="small">${esc(S.boot.actions[d.a])}</td><td class="num small faint">p=${fx(d.p[d.a])}</td></tr>`).join('')}</table></div>
    </div></div>`);
  const load = id => { if (!id) { $('#trp').innerHTML = empty('No other harness for this agent yet.'); return; } const w = replayWidget('rpt', { base: t.harness, cand: id, traceId: tid }); $('#trp').innerHTML = w.html; w.init(); };
  load(alt.length ? (alt.find(c => c.id.endsWith('-B')) || alt[alt.length - 1]).id : null);
  if ($('#altsel') && alt.length) $('#altsel').value = (alt.find(c => c.id.endsWith('-B')) || alt[alt.length - 1]).id;
  ACT.alt = el => load(el.value);
  ACT.label = el => post(`/api/trace/${tid}/label`, { verdict: el.dataset.v }).then(() => { toast('Label saved to calibration set'); route(); });
  ACT.tosuite = el => busy(el, async () => { const r = await post(`/api/trace/${tid}/to-suite`); toast(`Added as ${r.id}`); });
}

/* ------------------------------------------------------------------ evaluator health */
async function vEvaluators() {
  crumbs([['Evaluator health']]);
  const a = S.boot.agents.find(x => x.id === S.agent);
  if (!a.kind) { page(head('Evaluator health') + observeOnly(a)); return; }
  const d = await api(`/api/evaluators/${S.agent}`);
  const bad = d.items.filter(e => e.status !== 'Healthy');
  page(`${head('Evaluator health', `Judges are checked against human labels every week. Below κ ${fx(d.threshold)} a judge stops being used as an optimization reward until it is recalibrated.`)}
    ${bad.map(e => `<div class="alert ${e.status === 'Drifting' ? 'warn' : 'bad'}"><div><b>${esc(e.name)}</b> is ${e.status === 'Drifting' ? 'drifting' : 'below threshold'} (κ ${fx(e.kappa)}). ${e.role === 'Optimization paused' ? 'Optimization against it is paused.' : ''}
      ${e.id === 'resolution' && S.agent === 'outage' ? 'This judge cannot see whether a stated ETA was correct, so it over-passes ETA sessions; the tool-sequence check covers that gap.' : ''}</div>
      <button class="btn sm" data-act="recal" data-e="${e.id}" data-busy="Recalibrating…">Recalibrate</button></div>`).join('')}
    <div class="panel"><table><tr><th>Evaluator</th><th>Type</th><th class="num">Cohen's κ vs humans</th><th>Last 7 weeks</th><th>Status</th><th>Used as</th><th></th></tr>
      ${d.items.map(e => `<tr><td>${esc(e.name)}${e.criteria ? `<div class="small faint">${e.criteria.length} rubric criteria</div>` : ''}</td><td>${esc(e.type)}</td><td class="num">${e.kappa == null ? '<span class="faint">n/a</span>' : fx(e.kappa)}</td>
        <td>${spark(e.history, e.status === 'Healthy' ? '#000000' : '#EE0000', 110, 26, d.threshold)}</td><td>${status(e.status)}</td><td>${esc(e.role)}</td>
        <td>${e.kappa != null ? `<button class="btn sm ghost" data-act="recal" data-e="${e.id}" data-busy="…">Recalibrate</button>` : ''}</td></tr>`).join('')}</table></div>
    <div class="grid-2">
      <div class="panel"><h2>Calibration set</h2><div class="kv"><span class="k">Human-labeled sessions</span><span>${num(d.calibration.size)}</span>
        <span class="k">Added weekly</span><span>${d.calibration.weekly}</span><span class="k">Reserved as holdout</span><span>${pct(d.calibration.reserved, 0)}</span></div>
        <p class="small muted" style="margin-top:10px">Judges never see holdout labels. Recalibration updates rubric thresholds and few-shot examples, then re-measures κ on the holdout.</p></div>
      <div class="panel"><div class="panel-head"><h2>Labeling queue</h2><span class="small muted">${num(d.queue_total)} sessions near the judge's decision boundary</span></div>
        <table>${d.queue.slice(0, 10).map(t => `<tr><td class="mono small"><a href="#/traces/${t.id}">${t.id}</a></td><td class="small">${esc(t.label)}</td><td class="num small">${fx(t.judged_score)}</td>
          <td class="nowrap">${['Confirmed failure', 'Not a failure'].map(v => `<button class="btn sm ghost" data-act="qlabel" data-t="${t.id}" data-v="${v}">${v === 'Confirmed failure' ? 'Failure' : 'Fine'}</button>`).join('')}</td></tr>`).join('')}</table></div>
    </div>`);
  ACT.recal = btn => busy(btn, async () => { await post(`/api/evaluators/${S.agent}/${btn.dataset.e}/recalibrate`); toast('Recalibrated and re-measured on the holdout'); route(); });
  ACT.qlabel = el => post(`/api/trace/${el.dataset.t}/label`, { verdict: el.dataset.v }).then(() => { el.closest('tr').remove(); toast('Label saved'); });
}

/* ------------------------------------------------------------------ patterns */
async function vPatterns() {
  crumbs([['Pattern library']]);
  const d = await api('/api/patterns');
  const agents = S.boot.agents;
  page(`${head('Pattern library', 'Fixes proven on one agent, packaged so other agents with the same failure signature can test them.')}
    ${kpis([{ v: d.stats.proven, l: 'Proven patterns' }, { v: d.stats.agents_using, l: 'Agents using a pattern' }, { v: d.stats.registered, l: 'Registered agents' }, { v: d.stats.open_matches, l: 'Untested matches' }])}
    ${d.items.map(p => `<div class="panel"><div class="panel-head"><div><h2>${esc(p.name)}</h2><div class="small muted">${p.id} · ${esc(p.layer)} · proven on ${esc(p.proven_on_name)}${p.lift ? ` · ${esc(p.lift)}` : ''}${p.note ? ` · ${esc(p.note)}` : ''}</div></div></div>
      ${p.edit_labels.length ? `<ul class="small" style="margin:0 0 12px;padding-left:18px">${p.edit_labels.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p class="small muted">Context and memory change: not representable in the simulated harness.</p>'}
      <table><tr><th>Candidate agent</th><th>Integration</th><th>Result</th><th></th></tr>
      ${agents.filter(a => a.id !== p.proven_on).map(a => { const r = p.tests[a.id]; const match = p.matches.includes(a.id);
        return `<tr><td>${esc(a.name)} ${match ? '<span class="badge info">same signature</span>' : ''}</td><td class="small">${esc(a.integration)}</td>
          <td class="small">${r ? (r.status === 'tested' ? `<span class="${cls(r.lift)}">${pts(r.lift)}</span> resolution (${pts(r.lo)} to ${pts(r.hi)})` : `<span class="muted">${esc(r.message)}</span>`) : '<span class="faint">Not tested</span>'}</td>
          <td><button class="btn sm" data-act="ptest" data-p="${p.id}" data-a="${a.id}" data-busy="Testing…">Test</button></td></tr>`; }).join('')}</table></div>`).join('')}`);
  ACT.ptest = btn => busy(btn, async () => { const r = await post(`/api/pattern/${btn.dataset.p}/test`, { target: btn.dataset.a }); toast(r.message); route(); });
}

/* ------------------------------------------------------------------ agents */
async function vAgents() {
  crumbs([['Agents & connections']]);
  const d = await api('/api/agents');
  page(`${head('Agents & connections', 'What the engine can do depends on how each agent is connected. Third-party agents get recommendations and vendor change requests; first-party agents can get pull requests and weight updates.')}
    <div class="panel"><table><tr><th>Agent</th><th>Type</th><th>Integration</th><th>Owner</th><th class="num">Traffic</th><th>Production</th><th class="num">Traces</th></tr>
      ${d.items.map(a => `<tr><td>${esc(a.name)}${a.repo ? `<div class="small mono">${a.repo_url ? ext(a.repo_url, esc(a.repo)) : esc(a.repo)}${a.repo_path ? ` <span class="faint">/${esc(a.repo_path)}</span>` : ''}</div>` : ''}${a.vendor ? `<div class="small faint">Vendor ${esc(a.vendor)}</div>` : ''}</td><td>${esc(a.type)}</td><td>${esc(a.integration)}</td><td>${esc(a.owner)}</td>
        <td class="num">${esc(a.traffic)}</td><td class="mono">${esc(a.production || '—')}</td><td class="num">${num(a.traces)}</td></tr>`).join('')}</table></div>
    <div class="grid-main"><div class="panel"><h2>Capability by integration level</h2><div class="table-wrap"><table><tr><th>Capability</th>${d.levels.map(l => `<th>${esc(l[1])}</th>`).join('')}</tr>
      ${d.capabilities.map(c => `<tr><td>${esc(c.name)}</td>${c.values.map(v => `<td>${v === 'Yes' ? '<span class="badge good">Yes</span>' : v === 'No' ? '<span class="badge">No</span>' : '<span class="badge warn">Partial</span>'}</td>`).join('')}</tr>`).join('')}</table></div></div>
    <div class="panel"><h2>Register an agent</h2><div class="stack">
      <label class="field">Name<input type="text" id="an" placeholder="e.g. Fios Install Scheduler"></label>
      <label class="field">Type<select id="at"><option>First-party</option><option>Third-party</option></select></label>
      <label class="field">Integration<select id="al">${d.levels.map(l => `<option value="${l[0]}">${esc(l[1])}</option>`).join('')}</select></label>
      <label class="field">Owner<input type="text" id="ao"></label><label class="field">Weekly traffic<input type="text" id="atr" placeholder="e.g. 40K / wk"></label>
      <button class="btn primary" data-act="reg">Register agent</button></div></div></div>`);
  ACT.reg = btn => busy(btn, async () => { if (!$('#an').value) throw new Error('Give the agent a name.'); await post('/api/agents', { name: $('#an').value, type: $('#at').value, level: $('#al').value, owner: $('#ao').value, traffic: $('#atr').value }); await refreshBoot(); toast('Agent registered'); route(); });
}

/* ------------------------------------------------------------------ audit */
async function vAudit() {
  crumbs([['Audit log']]);
  const actor = S.query.get('actor') || '', q = S.query.get('q') || '';
  const d = await api(`/api/audit?${actor ? `actor=${encodeURIComponent(actor)}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`);
  page(`${head('Audit log', 'Append-only and hash-chained: every entry carries the SHA-256 of the one before it, so any edit breaks the chain.',
    `<button class="btn" data-act="verify" data-busy="Verifying…">Verify chain</button><a class="btn" href="/api/audit/export">Export JSONL</a>`)}
    <div id="vres"></div>
    <div class="panel"><div class="actions" style="margin-bottom:12px"><select data-change="actor"><option value="">All actors</option>${d.actors.map(a => `<option ${a === actor ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
      <input type="text" id="aq" placeholder="Search events, objects, details" value="${esc(q)}" style="min-width:280px"><button class="btn sm" data-act="search">Search</button>
      ${q || actor ? '<a class="btn sm ghost" href="#/audit">Clear</a>' : ''}<span class="small muted">${d.items.length} entries</span></div>
      <div class="table-wrap"><table><tr><th>Time</th><th>Actor</th><th>Event</th><th>Object</th><th>Detail</th><th>Hash</th></tr>
      ${d.items.map(r => `<tr><td class="nowrap small">${esc(r.time)}</td><td>${esc(r.actor)}</td><td>${esc(r.event)}</td><td><a class="mono small" href="#/audit?q=${encodeURIComponent(r.obj)}">${esc(r.obj)}</a></td>
        <td class="small">${esc(r.detail)}</td><td class="mono small faint" title="prev ${esc(r.prev)}">${r.hash.slice(0, 10)}…</td></tr>`).join('')}</table></div></div>`);
  ACT.actor = el => { location.hash = `#/audit?actor=${encodeURIComponent(el.value)}`; };
  ACT.search = () => { location.hash = `#/audit?q=${encodeURIComponent($('#aq').value)}`; };
  ACT.verify = btn => busy(btn, async () => { const r = await api('/api/audit/verify'); $('#vres').innerHTML = `<div class="alert ${r.ok ? 'info' : 'bad'}">${r.ok ? `Chain intact: ${r.entries} entries, head <span class="mono">${r.head.slice(0, 16)}…</span>` : `Chain broken at entry ${r.broken_at}`}</div>`; });
}

/* ------------------------------------------------------------------ under the hood */
const hoodSrc = files => `<div class="small faint" style="margin-top:10px">Source: ${files.map(f => `<span class="mono">${esc(f)}</span>`).join(', ')}</div>`;
const steps = items => `<ol class="steps">${items.map(s => `<li>${s}</li>`).join('')}</ol>`;
async function hoodData(section, title) {
  crumbs([[NAV_GROUP(section)], [title]]);
  const a = S.boot.agents.find(x => x.id === S.agent);
  if (!a.kind) { page(head(title) + observeOnly(a)); return null; }
  return api(`/api/hood/${section}/${S.agent}`);
}

async function vHoodDetection() {
  const d = await hoodData('detection', 'Detection'); if (!d) return;
  const only = d.overlap.find(o => o.signals === 1)?.traces || 0;
  const maxO = Math.max(...d.overlap.map(o => o.traces));
  page(`${head('Detection', 'How a production session becomes a flagged trace. Six independent signals are ORed together, then each flagged trace is assigned to exactly one failure theme.')}
    ${kpis([{ v: num(d.traces), l: 'Traces (14 days)' }, { v: num(d.flagged), l: 'Flagged' }, { v: pct(d.rate), l: 'Flag rate' }, { v: num(only), l: 'Caught by a single signal' }])}
    <div class="panel"><h2>How it works</h2>${steps([
      'Every trace is scored by the evaluators (LLM judges, policy rules, tool-sequence check) and joined with outcome data (repeat contact, CSAT) and any human flag.',
      'A trace is flagged if <b>any</b> signal fires. No single signal is trusted alone: judges miss failures, outcomes arrive late, humans sample sparsely.',
      'Flagged traces are matched against failure signatures in a fixed order. The first match wins, so a policy breach is never hidden inside a softer theme.',
      'Anything with no shared signature lands in <i>Flagged with no clear pattern</i>, which is also where judge false positives collect.'])}
      <pre class="code">flagged = (not judged_pass) or violation or repeat or anomaly or csat &lt;= 2 or human_flag</pre>
      ${hoodSrc(['backend/engine/analysis.py · is_flagged, theme_of'])}</div>
    <div class="grid-main">
      <div class="panel"><h2>Signals</h2><table><tr><th>Signal</th><th>Condition</th><th class="num">Traces hit</th><th class="num">Only signal</th></tr>
        ${d.signals.map(s => `<tr><td>${esc(s.label)}</td><td class="mono small">${esc(s.expr)}</td><td class="num">${num(s.hits)}</td><td class="num">${num(s.sole)}</td></tr>`).join('')}</table>
        <p class="small muted" style="margin-top:10px"><b>Only signal</b> counts flagged traces that no other signal caught: what you would lose by dropping that signal.</p></div>
      <div class="panel"><h2>Signal overlap</h2>${d.overlap.map(o => hbar(`${o.signals} signal${o.signals > 1 ? 's' : ''} fired`, o.traces, maxO)).join('')}</div>
    </div>
    <div class="panel"><h2>Theme assignment, first match wins</h2><table><tr><th>#</th><th>Theme</th><th>Layer</th><th class="num">Traces assigned</th></tr>
      ${d.themes.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.name)}</td><td class="small">${esc(t.layer)}</td><td class="num">${num(t.assigned)}</td></tr>`).join('')}</table></div>`);
}

async function vHoodRootCause() {
  const d = await hoodData('rootcause', 'Root cause'); if (!d) return;
  page(`${head('Root cause', 'Each theme is traced back to the harness release where it started, by comparing its rate across versions.')}
    <div class="panel"><h2>How it works</h2>${steps([
      'For each theme, count its traces per harness version and divide by that version\'s total traffic. Raw counts would favour versions that ran longer.',
      'Order versions by release day and find the largest rise in rate between two consecutive releases.',
      'The edits made in that release become the hypothesis. A signature check adds the mechanism (for example close_ticket called within one turn of quote_credit).',
      'Confidence scales with how much of the current rate the jump explains: <span class="mono">clamp(0.5 + 0.45 × jump ÷ rate_after, 0.35, 0.95)</span>. With a single version there is no jump, so confidence stays at the 0.55 prior.'])}
      ${hoodSrc(['backend/engine/analysis.py · root_cause'])}</div>
    ${d.themes.map(t => `<div class="panel"><div class="panel-head"><div><h2>${esc(t.name)}</h2><div class="small muted">${sevBadge(t.sev)} Confidence ${pct(t.confidence, 0)}</div></div>
      <a class="btn sm ghost" href="#/themes/${t.id}">Open theme</a></div>
      <table><tr><th>Version</th><th class="num">Released (day)</th><th class="num">Traces</th><th class="num">Theme traces</th><th class="num">Rate</th><th></th></tr>
      ${t.rows.map(r => `<tr${t.change && r.version === t.change.to ? ' class="hl"' : ''}><td class="mono">${esc(r.version)}</td><td class="num">${r.released_day}</td><td class="num">${num(r.traces)}</td><td class="num">${num(r.hits)}</td><td class="num">${pct(r.rate)}</td>
        <td class="small">${t.change && r.version === t.change.to ? `<span class="neg">${pts(t.jump)} vs ${esc(t.change.from)}</span>` : ''}</td></tr>`).join('')}</table>
      ${t.change ? `<div class="small" style="margin-top:10px"><b>Changed in ${esc(t.change.to)}:</b> ${t.change.edits.map(esc).join('; ') || 'no harness edits'}</div>` : `<div class="small muted" style="margin-top:10px">${t.rows.length < 2 ? 'Only one version in the window, so no release can be blamed.' : 'No release raised the rate, so none is blamed.'} The hypothesis rests on the failure signature alone.</div>`}
      <p class="small muted">${esc(t.text)}</p></div>`).join('') || `<div class="panel">${empty('No themes to explain yet.')}</div>`}`);
}

function histogram(h, res) {
  const W = 560, H = 190, L = 12, R = 12, T = 10, B = 30, n = h.counts.length;
  const max = Math.max(...h.counts, 1), bw = (W - L - R) / n;
  const span = h.width * n, X = v => L + (W - L - R) * (v - h.lo) / (span || 1);
  let g = h.counts.map((c, i) => { const v = h.lo + (i + .5) * h.width, inCI = v >= res.lo && v <= res.hi;
    return `<rect x="${L + i * bw + 1}" y="${T + (H - T - B) * (1 - c / max)}" width="${bw - 2}" height="${(H - T - B) * c / max}" fill="${inCI ? '#000000' : '#D0D0D0'}"/>`; }).join('');
  const mark = (v, label, color) => v >= h.lo && v <= h.lo + span ? `<line x1="${X(v)}" x2="${X(v)}" y1="${T}" y2="${H - B}" stroke="${color}" stroke-dasharray="4 3"/><text x="${X(v)}" y="${H - 14}" text-anchor="middle" style="fill:${color}">${label}</text>` : '';
  g += mark(0, '0', '#EE0000') + mark(res.lo, pts(res.lo), '#EE0000') + mark(res.hi, pts(res.hi), '#EE0000');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bootstrap distribution of the difference">${g}</svg>`;
}

async function vHoodStatistics() {
  const d = await hoodData('statistics', 'Statistics'); if (!d) return;
  const metric = S.query.get('m') === 'gold' ? 'gold' : 'judged_pass';
  const m = d.metrics?.[metric], r = m?.result;
  page(`${head('Statistics', 'How the engine decides a change really helped: paired replays, a bootstrap confidence interval, and a multiple-comparison correction.')}
    <div class="panel"><h2>How it works</h2>${steps([
      '<b>Paired replays.</b> Baseline and candidate run the same scenarios with the same random draws (common random numbers). Transcripts stay identical until a decision actually changes, so most pairs cancel out and the noise drops sharply.',
      '<b>Paired bootstrap.</b> Take the per-scenario differences (candidate minus baseline), resample them with replacement B times and take the mean each time. The 2.5th and 97.5th percentiles give the 95% interval, and the share of resamples on the wrong side of zero gives the p-value.',
      '<b>Holm correction.</b> When one experiment compares several candidates, sort their p-values and multiply the k-th smallest by (m − k + 1), keeping the sequence monotone. A candidate is significant only if its adjusted p &lt; 0.05 <i>and</i> its interval sits above zero.',
      '<b>Judge vs human audit.</b> The same test runs on the judge verdict and on the human-audited outcome. If they disagree, the judge is the problem, not the fix.'])}
      ${hoodSrc(['backend/engine/evaluate.py · paired_bootstrap, holm, kappa'])}</div>
    ${d.cand ? `<div class="panel"><div class="panel-head"><div><h2>Live example: ${esc(d.base)} vs ${esc(d.cand)}</h2><div class="small muted">${d.edits.map(esc).join('; ')} · n = ${num(d.n)} paired scenarios · B = ${d.B} resamples</div></div>
        <div class="seg">${[['judged_pass', 'Judge verdict'], ['gold', 'Human audit']].map(([k, l]) => `<button class="${k === metric ? 'on' : ''}" data-act="metric" data-m="${k}">${l}</button>`).join('')}</div></div>
      ${kpis([{ v: `<span class="${cls(r.diff)}">${pts(r.diff)}</span>`, l: 'Mean difference' }, { v: `${pts(r.lo)} to ${pts(r.hi)}`, l: '95% interval' }, { v: fx(r.p, 3), l: 'Bootstrap p-value' }, { v: num(m.pairs.gained + m.pairs.lost), l: 'Pairs that changed' }])}
      <div class="grid-2"><div>${histogram(m.hist, r)}<div class="small muted">Bootstrap distribution of the mean difference. Dark bars fall inside the 95% interval; the red line is zero.</div></div>
        <div><table><tr><th></th><th class="num">Candidate pass</th><th class="num">Candidate fail</th></tr>
          <tr><th>Baseline pass</th><td class="num">${num(m.pairs.both_pass)}</td><td class="num neg">${num(m.pairs.lost)}</td></tr>
          <tr><th>Baseline fail</th><td class="num pos">${num(m.pairs.gained)}</td><td class="num">${num(m.pairs.both_fail)}</td></tr></table>
          <p class="small muted" style="margin-top:10px">Only the off-diagonal pairs carry information. The difference is (${m.pairs.gained} − ${m.pairs.lost}) ÷ ${d.n} = ${pts(r.diff)}.</p></div></div></div>`
      : `<div class="panel">${empty('No candidate harness derived from production yet. Generate a fix bundle to see a live example.')}</div>`}
    ${d.holm ? `<div class="panel"><div class="panel-head"><h2>Holm correction in ${esc(d.holm.id)}</h2><a class="btn sm ghost" href="#/experiments/${d.holm.id}">Open experiment</a></div>
      <table><tr><th>Candidate</th><th class="num">Lift</th><th class="num">95% interval</th><th class="num">Raw p</th><th class="num">Holm p</th><th>Significant</th></tr>
      ${d.holm.rows.map(x => `<tr><td>${esc(x.name)}</td><td class="num ${cls(x.diff)}">${pts(x.diff)}</td><td class="num small">${pts(x.lo)} to ${pts(x.hi)}</td><td class="num">${fx(x.p, 3)}</td><td class="num">${fx(x.p_holm, 3)}</td>
        <td>${x.significant ? '<span class="badge good">Yes</span>' : '<span class="badge">No</span>'}</td></tr>`).join('')}</table></div>` : ''}`);
  ACT.metric = el => { location.hash = `#/statistics${el.dataset.m === 'gold' ? '?m=gold' : ''}`; };
}

async function vHoodJudges() {
  const d = await hoodData('judges', 'Judges'); if (!d) return;
  const c = d.confusion, p = d.params, b = d.bias;
  const best = (b.criteria - 1) / b.criteria + p.verbosity_bias, canFlip = best >= p.threshold;
  page(`${head('Judges', 'How the resolution judge scores a session, where it is wrong, and how agreement with humans is measured.')}
    <div class="panel"><h2>How it works</h2>${steps([
      'The judge checks each rubric criterion. A criterion that truly holds is scored as met unless the judge <b>false-fails</b> it; one that does not hold is scored as met only when the judge <b>misses</b> it.',
      `Score = share of criteria met, plus a <b>verbosity bonus</b> of ${fx(p.verbosity_bias)} when the agent ends with a detailed summary, plus Gaussian noise (σ ${fx(p.noise)}). The session passes at score ≥ ${fx(p.threshold)}.`,
      'The verbosity bonus is deliberate: it is the flaw an optimizer can learn to exploit (reward hacking). Human-audited outcomes expose it.',
      `Agreement with human labels is measured with Cohen's κ on the calibration set. Below κ ${fx(d.threshold)} the judge stops being used as an optimization reward until it is recalibrated.`])}
      ${hoodSrc(['backend/engine/judges.py · resolution', 'backend/engine/evaluate.py · kappa'])}</div>
    <div class="grid-2">
      <div class="panel"><h2>Resolution judge settings</h2><div class="kv">
        <span class="k">Miss rate</span><span>${pct(p.miss)}</span><span class="k">False-fail rate</span><span>${pct(p.false_fail)}</span>
        <span class="k">Score noise σ</span><span>${fx(p.noise)}</span><span class="k">Verbosity bonus</span><span>+${fx(p.verbosity_bias)}</span>
        <span class="k">Pass threshold</span><span>${fx(p.threshold)}</span></div>
        <h3 style="margin-top:14px">Rubric</h3><ul class="small" style="margin:0;padding-left:18px">${d.criteria.map(x => `<li>${esc(x.text)} <span class="mono faint">${esc(x.id)}</span></li>`).join('')}</ul></div>
      <div class="panel"><h2>Agreement with humans (n = ${num(d.n)})</h2>
        <table><tr><th></th><th class="num">Human: resolved</th><th class="num">Human: not resolved</th></tr>
          <tr><th>Judge: pass</th><td class="num">${num(c.tp)}</td><td class="num neg">${num(c.fp)}</td></tr>
          <tr><th>Judge: fail</th><td class="num neg">${num(c.fn)}</td><td class="num">${num(c.tn)}</td></tr></table>
        <div class="kv" style="margin-top:12px"><span class="k">Observed agreement p<sub>o</sub></span><span>${fx(d.po, 3)}</span>
          <span class="k">Chance agreement p<sub>e</sub></span><span>${fx(d.pe, 3)}</span>
          <span class="k">κ = (p<sub>o</sub> − p<sub>e</sub>) ÷ (1 − p<sub>e</sub>)</span><span><b>${fx(d.kappa, 3)}</b> ${d.kappa >= d.threshold ? '<span class="badge good">Above threshold</span>' : '<span class="badge bad">Below threshold</span>'}</span></div></div>
    </div>
    <div class="panel"><h2>What the verbosity bonus costs</h2>
      <p class="small muted">The ${num(b.unresolved)} calibration sessions that humans say were <b>not</b> resolved, scored twice by the same judge: once as configured, once with the bonus switched off.</p>
      <div class="kv"><span class="k">Mean judge score, unresolved sessions with a detailed summary (n = ${num(b.detailed)})</span><span>${fx(b.score_on, 3)} → <b>${fx(b.score_off, 3)}</b> without the bonus</span>
        <span class="k">False passes (judge pass, human says not resolved)</span><span>${num(b.false_pass)} → <b>${num(b.false_pass_no_bonus)}</b> without the bonus</span></div>
      <p class="small" style="margin-top:10px">${canFlip
        ? `<b>${num(b.bonus_only)}</b> unresolved sessions pass only because of the bonus. With ${b.criteria} criteria, one missed criterion plus the bonus scores ${fx(best, 2)}, over the ${fx(p.threshold)} threshold.`
        : `With ${b.criteria} criteria, one missed criterion plus the bonus scores at most ${fx(best, 2)}, below the ${fx(p.threshold)} threshold, so the bonus never flips a verdict here.`}
        It still inflates the <b>score</b>, and RL uses the score as its reward. That is enough for a policy to learn longer closings without resolving anything.</p></div>
    <div class="panel"><div class="panel-head"><h2>All evaluators</h2><a class="btn sm ghost" href="#/evaluators">Evaluator health</a></div>
      <table><tr><th>Evaluator</th><th>Type</th><th class="num">κ</th><th>Status</th><th>Used as</th></tr>
      ${d.evaluators.map(e => `<tr><td>${esc(e.name)}</td><td>${esc(e.type)}</td><td class="num">${e.kappa == null ? '<span class="faint">n/a</span>' : fx(e.kappa)}</td><td>${status(e.status)}</td><td>${esc(e.role)}</td></tr>`).join('')}</table></div>`);
}

async function vHoodRelease() {
  const d = await hoodData('release', 'Release'); if (!d) return;
  const g = d.gate;
  page(`${head('Release', 'How a validated change reaches production: routed approvals, a regression gate, then a staged rollout that rolls itself back.')}
    <div class="panel"><h2>How it works</h2>${steps([
      'The change is classified by the riskiest layer it touches (prompt, tools, control flow, evaluator, guardrail, model weights). That class decides who must approve.',
      `Third-party agents also need vendor attestation that the deployed version matches the approved <a href="#/manifest">manifest hash</a>.${d.third_party ? ' <b>This agent is third-party.</b>' : ''}`,
      'Before approval, the candidate runs the regression suite. It must clear the pass-rate gate, and every policy test must pass.',
      `Once all approvers sign off, each rollout stage replays fresh scenarios against production. A stage <b>rolls back automatically</b> if resolution drops by more than ${fx(d.rollback.resolution_drop * 100, 1)} pts or the violation rate rises by more than ${fx(d.rollback.violation_rise * 100, 1)} pts.`,
      'Passing the last stage promotes the candidate to production, bumps the version and adds the fix to the pattern library. Every step is written to the audit log.'])}
      ${hoodSrc(['backend/state.py · route, run_suite, advance, promote_to_prod'])}</div>
    <div class="panel"><h2>Approval routing</h2><table><tr><th>Change type</th><th>Approvers</th><th>Rollout</th></tr>
      ${d.policy.map(p => `<tr><td>${esc(p.type)}</td><td>${p.approvers.map(a => `<span class="badge purple">${esc(a)}</span>`).join(' ')}</td><td class="small">${esc(p.rollout)}</td></tr>`).join('')}</table></div>
    <div class="grid-2">
      <div class="panel"><h2>Rollout stages</h2><table><tr><th>#</th><th>Stage</th><th class="num">Replayed scenarios</th></tr>
        ${d.stages.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.name)}</td><td class="num">${num(s.n)}</td></tr>`).join('')}</table></div>
      <div class="panel"><h2>Regression gate</h2>${g ? `<div class="kv"><span class="k">Suite</span><span class="mono">${esc(g.suite)}</span><span class="k">Tests</span><span>${num(g.tests)}</span>
        <span class="k">Minimum pass rate</span><span>${pct(g.min_pass, 0)}</span><span class="k">All policy tests must pass</span><span>${g.policy_all ? 'Yes' : 'No'}</span>
        <span class="k">Changing the gate</span><span>${g.gov_signoff ? 'Requires AI Governance sign-off' : 'Owner'}</span>
        <span class="k">Last run</span><span>${g.last_run ? `${esc(g.last_run.name)}: ${g.last_run.passed}/${g.last_run.total} ${g.last_run.gate_ok ? status('Passed') : status('failed')}` : '<span class="faint">None</span>'}</span></div>
        <a class="btn sm ghost" href="#/regression" style="margin-top:8px">Regression suites</a>` : empty('No regression suite for this agent.')}</div>
    </div>
    <div class="panel"><h2>Changes for this agent</h2>${d.approvals.length ? `<table><tr><th>Change</th><th>Type</th><th>Risk</th><th>Status</th><th>Progress</th></tr>
      ${d.approvals.map(a => `<tr class="click" data-href="#/approvals/${a.id}"><td><span class="mono small">${a.id}</span> ${esc(a.title)}</td><td class="small">${esc(a.change_type)}</td><td>${sevBadge(a.risk)}</td><td>${status(a.status)}</td>
        <td class="small">${a.waiting_on ? `Waiting on ${esc(a.waiting_on)}` : a.stage != null && a.stage >= 0 ? `Stage ${a.stage + 1} of ${d.stages.length} passed` : a.stage === -1 ? 'Ready for shadow' : ''}</td></tr>`).join('')}</table>` : empty('No changes routed yet.')}</div>`);
}

async function vHoodManifest() {
  const d = await hoodData('manifest', 'Manifest hash'); if (!d) return;
  const short = h => `${h.slice(0, 12)}…`;
  page(`${head('Manifest hash', 'A content fingerprint for every harness version, so approvers, auditors and vendors can prove exactly which harness is running.')}
    <div class="panel"><h2>How it works</h2>${steps([
      'Each harness is written out as a canonical manifest: prompt lines (full text, with frozen markers), gates, tool descriptions, evaluator criteria and a SHA-256 of any RL adapter weights.',
      'Names and version labels are left out on purpose. Two harnesses with identical behaviour get the same hash, and a renamed copy cannot pass as a new version.',
      'The manifest is serialised as JSON with sorted keys and no whitespace, then hashed with SHA-256.',
      'A second hash covers only the frozen policy lines. If it is the same across every version, no edit has touched identity or credit policy.',
      'Third-party vendors attest to the hash they deployed. Paste it below to check it against every known version.'])}
      ${hoodSrc(['backend/hood.py · manifest, manifest_hash, frozen_hash'])}</div>
    <div class="alert ${d.frozen_ok ? 'info' : 'bad'}"><div>${d.frozen_ok ? 'Frozen policy lines are identical in every version of this agent.' : 'Frozen policy lines differ between versions. Investigate before approving anything.'}</div></div>
    <div class="panel"><h2>Versions</h2><div class="table-wrap"><table><tr><th>Harness</th><th>Version</th><th>Parent</th><th>Manifest hash</th><th>Frozen-lines hash</th><th></th></tr>
      ${d.items.map(r => `<tr><td>${esc(r.name)}</td><td class="mono">${esc(r.version)}</td><td class="mono small faint">${esc(r.parent || '—')}</td>
        <td class="mono small" title="${r.hash}">${short(r.hash)}</td><td class="mono small faint" title="${r.frozen}">${short(r.frozen)}</td>
        <td class="nowrap">${r.production ? status('Live') : ''} ${r.released && !r.production ? '<span class="badge">Released</span>' : ''} ${r.has_adapter ? '<span class="badge purple">Adapter</span>' : ''} ${r.shared ? '<span class="badge warn" title="Another harness has identical content">Same content</span>' : ''}</td></tr>`).join('')}</table></div></div>
    <div class="panel"><h2>Verify a hash</h2><div class="actions"><input type="text" id="mh" class="mono" placeholder="Paste a manifest hash (8+ characters)" style="min-width:420px">
      <button class="btn" data-act="mverify" data-busy="Checking…">Verify</button></div><div id="mres" style="margin-top:12px"></div></div>
    ${d.production ? `<div class="panel"><div class="panel-head"><h2>Production manifest</h2><span class="mono small">sha256 ${esc(d.production.hash)}</span></div>
      <pre class="code">${esc(JSON.stringify(d.production.manifest, null, 2))}</pre></div>` : ''}`);
  ACT.mverify = btn => busy(btn, async () => {
    const r = await post(`/api/hood/manifest/${S.agent}/verify`, { hash: $('#mh').value });
    $('#mres').innerHTML = r.match ? `<div class="alert info"><div>Matches ${r.items.map(i => `<b>${esc(i.name)}</b> (${esc(i.version)})${i.production ? ', the harness in production' : ''}`).join('; ')}.</div></div>`
      : '<div class="alert bad"><div>No harness for this agent has that hash. The deployed configuration differs from every approved version.</div></div>';
  });
}

/* ------------------------------------------------------------------ version control */
const PR_BADGE = { open: 'good', merged: 'purple', closed: '' };
function vcsHTML(d, fresh) {
  const sy = d.sync, isNew = k => fresh.has(k) ? ' <span class="badge bad">new</span>' : '';
  const syncAlert = !sy ? '' : sy.in_sync
    ? `<div class="alert info"><div><b>In sync.</b> The code this server is running matches <span class="mono">${esc(d.repo_meta.default_branch)}</span> @ ${ext(d.head.url, d.head.short, 'mono')} (${sy.compared} files compared by git blob hash).</div></div>`
    : `<div class="alert bad"><div><b>${sy.drift.length} file${sy.drift.length > 1 ? 's' : ''} differ from ${esc(d.repo_meta.default_branch)}</b> @ ${ext(d.head.url, d.head.short, 'mono')}. The running code has changes that are not on GitHub, or GitHub has changes that are not deployed.
        <ul class="small" style="margin:6px 0 0;padding-left:18px">${sy.drift.map(f => `<li><span class="mono">${f.url ? ext(f.url, esc(f.path)) : esc(f.path)}</span> · ${esc(f.status)}</li>`).join('')}</ul></div></div>`;
  const open = (d.pulls || []).filter(p => p.state === 'open').length;
  return `${d.error ? `<div class="alert warn"><div><b>Could not reach GitHub:</b> ${esc(d.error)}${d.commits ? ' Showing the last good sync.' : ''}</div></div>` : ''}
    ${syncAlert}
    ${d.commits ? kpis([{ v: ext(d.head.url, d.head.short, 'mono'), l: `Head of ${d.repo_meta.default_branch}` }, { v: open, l: 'Open pull requests', d: `${d.pulls.length} recent in total` },
      { v: d.branches.length, l: 'Branches' }, { v: esc((d.repo_meta.pushed_at || '').replace(' UTC', '')), l: 'Last push (UTC)' }]) : ''}
    <div class="small muted" style="margin:-8px 0 16px">Checked ${esc(d.checked_at || '—')} · data from ${esc(d.fetched_at || '—')} · next GitHub check in ~${d.next_check_s}s (every ${d.poll_s}s${d.read_auth ? '' : ', anonymous: set HOE_GITHUB_READ_TOKEN for 15s'}) ·
      API ${d.rate.remaining ?? '?'}/${d.rate.limit ?? '?'} left · pull requests: ${d.live ? '<b>live</b>' : 'dry run'}</div>
    ${d.commits ? `<div class="grid-2">
      <div class="panel"><div class="panel-head"><h2>Commits on ${esc(d.repo_meta.default_branch)}</h2>${ext(`${d.url}/commits/${d.repo_meta.default_branch}`, 'All commits')}</div>
        <table><tr><th>Commit</th><th>Message</th><th>Author</th><th>Date (UTC)</th></tr>
        ${d.commits.map(c => `<tr><td>${ext(c.url, c.short, 'mono')}</td><td>${esc(c.message)}${c.merge ? ' <span class="badge">merge</span>' : ''}${isNew('c:' + c.sha)}</td><td class="small">${esc(c.author)}</td><td class="small nowrap">${esc(c.date.replace(' UTC', ''))}</td></tr>`).join('')}</table></div>
      <div class="panel"><div class="panel-head"><h2>Pull requests</h2>${ext(d.pulls_url || `${d.url}/pulls`, 'All pull requests')}</div>
        ${d.pulls.length ? `<table><tr><th>#</th><th>Title</th><th>State</th><th>Updated (UTC)</th></tr>
        ${d.pulls.map(p => `<tr><td>${ext(p.url, '#' + p.number)}</td><td>${esc(p.title)}${p.hoe ? ' <span class="badge info">HOE</span>' : ''}${isNew(`p:${p.number}:${p.state}`)}<div class="small faint mono">${esc(p.branch)} → ${esc(p.base)} · ${esc(p.author)}</div></td>
          <td><span class="badge ${PR_BADGE[p.state] ?? ''}">${esc(p.state)}</span></td><td class="small nowrap">${esc(p.updated.replace(' UTC', ''))}</td></tr>`).join('')}</table>` : empty('No pull requests yet.')}</div>
    </div>
    <div class="grid-2">
      <div class="panel"><h2>Branches</h2><table><tr><th>Branch</th><th>Head</th><th class="num">Ahead</th><th class="num">Behind</th><th>Pull request</th></tr>
        ${d.branches.map(b => `<tr><td>${ext(b.url, esc(b.name), 'mono')}${b.default ? ' <span class="badge">default</span>' : ''}${b.hoe ? ' <span class="badge info">HOE</span>' : ''}${isNew('b:' + b.name + ':' + b.sha)}</td>
          <td>${ext(b.commit_url, b.short, 'mono')}</td><td class="num">${b.default ? '—' : b.ahead}</td><td class="num">${b.default ? '—' : b.behind}</td>
          <td>${b.pr ? `${ext(b.pr.url, '#' + b.pr.number)} <span class="badge ${PR_BADGE[b.pr.state] ?? ''}">${esc(b.pr.state)}</span>` : '<span class="faint">none</span>'}</td></tr>`).join('')}</table></div>
      <div class="panel"><div class="panel-head"><h2>Git activity in this app</h2><a href="#/audit?q=Pull%20request">Audit log</a></div>
        ${d.activity.length ? `<table><tr><th>Time</th><th>Event</th><th>Detail</th></tr>${d.activity.map(r => `<tr><td class="small nowrap">${esc(r.time)}</td><td class="small">${esc(r.event)}<div class="faint">${esc(r.obj)}</div></td>
          <td class="small">${esc(r.detail).replace(/(https:\/\/github\.com\/[^\s]+)/g, u => ext(u, u))}</td></tr>`).join('')}</table>`
          : empty('No Git activity yet. Open a pull request from a fix bundle, or press Sync now.')}</div>
    </div>
    ${sy && sy.neutral.length ? `<div class="panel"><h2>Not part of this deployment</h2><p class="small muted">Files outside the runnable code (backend, frontend, requirements.txt) that exist on only one side. Expected on a zip deployment.</p>
      <ul class="small mono" style="margin:0;padding-left:18px">${sy.neutral.map(f => `<li>${f.url ? ext(f.url, esc(f.path)) : esc(f.path)} <span class="faint">· ${esc(f.status)}</span></li>`).join('')}</ul></div>` : ''}` : ''}`;
}

function vcsKeys(d) {
  return new Set([...(d.commits || []).map(c => 'c:' + c.sha), ...(d.pulls || []).map(p => `p:${p.number}:${p.state}`),
    ...(d.branches || []).map(b => 'b:' + b.name + ':' + b.sha)]);
}

async function vVcs() {
  crumbs([[NAV_GROUP('vcs')], ['Version control']]);
  const draw = (d, announce) => {
    const keys = vcsKeys(d), prev = S.vcsSeen;
    const fresh = prev ? new Set([...keys].filter(k => !prev.has(k))) : new Set();
    S.vcsSeen = keys;
    const box = $('#vcsbody');
    if (!box) return;
    box.innerHTML = vcsHTML(d, fresh);
    if (announce && fresh.size) toast(`GitHub changed: ${fresh.size} new item${fresh.size > 1 ? 's' : ''}`);
  };
  page(`${head('Version control', `${ext(S.boot.git.url, esc(S.boot.git.repo))} · the code, branches and pull requests this app delivers to, kept in sync with GitHub`,
    `<button class="btn primary" data-act="vsync" data-busy="Syncing…">Sync now</button>${ext(S.boot.git.url, 'Open on GitHub', 'btn')}`)}
    <div id="vcsbody"><div class="loading">Reading GitHub…</div></div>`);
  draw(await api('/api/vcs'), false);
  ACT.vsync = btn => busy(btn, async () => { draw(await post('/api/vcs/sync'), true); toast('Synced with GitHub'); });
  S.timers.push(setInterval(async () => { try { draw(await api('/api/vcs'), true); } catch (e) { /* keep last view */ } }, 15000));
}

/* ------------------------------------------------------------------ introduction */
const FLOW_STEPS = [
  { n: 1, name: 'Failed traces', what: 'Every production session is scored by LLM judges, policy rules and a tool-sequence check, then joined with outcomes (repeat contact, CSAT) and human flags. A session is flagged if any signal fires.',
    tools: [['evaluators', 'Evaluator health'], ['traces', 'Evidence explorer'], ['judges', 'Judges']], code: ['backend/engine/env.py', 'backend/engine/judges.py', 'backend/state.py', 'backend/engine/evaluate.py', 'backend/engine/analysis.py'] },
  { n: 2, name: 'Failure themes', what: 'Flagged traces are clustered by failure signature into themes, each with severity, trend, repeat-contact rate and sub-clusters. The Verizon lookup table maps signatures to business meaning.',
    tools: [['themes', 'Failure themes']], code: ['backend/engine/analysis.py'], input: 'Verizon lookup table' },
  { n: 3, name: 'RCA categories', what: 'Each theme is traced to the harness release where it started, by comparing its rate across versions, and tagged with a root-cause category (for example "intent was missed"). The Verizon policy doc defines what must never change.',
    tools: [['fixes', 'Fix bundles'], ['rootcause', 'Root cause']], code: ['backend/engine/analysis.py'], input: 'Verizon policy doc' },
  { n: 4, name: 'RCA solution bundles', what: 'For each root cause the engine proposes fixes: prompt lines, tool descriptions, control-flow gates, evaluator criteria. Harness search refines them; RL fine-tuning (PPO, DPO, GRPO) is the alternative when a prompt change is not enough.',
    tools: [['optimizer', 'Optimizer & RL'], ['evaluators', 'Evaluator health*']], code: ['backend/engine/optimizer.py', 'backend/engine/rl.py'] },
  { n: 5, name: 'Experiments', what: 'Candidates are replayed against the same held-out scenarios as production, with paired bootstrap intervals, Holm correction across candidates, a quality-versus-cost view and a reward-hacking check.',
    tools: [['experiments', 'Experiments']], code: ['backend/engine/evaluate.py'] },
  { n: 6, name: 'Human approval', what: 'Changes route to approvers by risk: a prompt tweak needs the agent owner; guardrail, evaluator or model-weight changes add AI Governance, Security or Model Risk. Proven fixes join the pattern library.',
    tools: [['patterns', 'Pattern library'], ['approvals', 'Approvals'], ['audit', 'Audit log']], code: ['backend/state.py'] },
  { n: 7, name: 'Regression', what: 'The theme becomes deduplicated regression tests. A candidate must pass at least 98% of them and every policy test before rollout. A failure sends it back to experiments.',
    tools: [['regression', 'Regression suites']], code: ['backend/state.py'] },
  { n: 8, name: 'Staged rollout', what: 'Shadow traffic, then 5%, 25% and 50% canaries, then full rollout. Each stage replays fresh scenarios and rolls back on its own if resolution drops more than 1 pt or violations rise. Delivery is a pull request, registry publish, config API or gateway overlay.',
    tools: [['agents', 'Agents & connections'], ['release', 'Release']], code: ['backend/state.py', 'backend/engine/vcs.py'] },
];

// node text on one line, or two when it would overflow the box
function nodeLabel(x, cy, t) {
  if (t.length <= 16) return `<text x="${x}" y="${cy + 4}" class="fn">${esc(t)}</text>`;
  const w = t.split(' '), mid = Math.ceil(w.length / 2);
  return `<text x="${x}" y="${cy - 3}" class="fn"><tspan x="${x}">${esc(w.slice(0, mid).join(' '))}</tspan><tspan x="${x}" dy="14">${esc(w.slice(mid).join(' '))}</tspan></text>`;
}

function flowDiagram() {
  const L = 128, CW = 139, W = L + CW * 8 + 8, cx = i => L + CW * i + CW / 2, NW = 124;
  const lanes = [['Core workflow', 40, 205, '#FFF1F1', '#EE0000'], ['Demo tool', 257, 118, '#F6F6F6', '#000000'],
    ['Example', 387, 62, '#FFF8E6', '#A36A00'], ['Code', 461, 146, '#EEF6F0', '#00752F']];
  let g = `<defs>
    <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#000"/></marker>
    <marker id="ahr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#EE0000"/></marker>
    <marker id="ahg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#555"/></marker>
    <marker id="ahc" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#00752F"/></marker></defs>`;
  for (let i = 0; i < 8; i++) g += `<text x="${cx(i)}" y="24" class="fh">Step ${i + 1}</text>`;
  for (let i = 1; i < 8; i++) g += `<line x1="${L + CW * i}" x2="${L + CW * i}" y1="34" y2="612" stroke="#D8DADA" stroke-dasharray="3 4"/>`;
  lanes.forEach(([name, y, h, bg, accent]) => {
    g += `<rect x="0" y="${y}" width="${W}" height="${h}" rx="8" fill="${bg}"/><rect x="0" y="${y}" width="4" height="${h}" fill="${accent}"/>
      <text x="16" y="${y + h / 2 + 5}" class="fl" fill="${accent === '#000000' ? '#000' : accent}">${name}</text>`;
  });
  // core nodes and arrows
  const ny = 96, nh = 44;
  FLOW_STEPS.forEach((st, i) => {
    g += `<rect x="${cx(i) - NW / 2}" y="${ny}" width="${NW}" height="${nh}" rx="8" fill="#fff" stroke="#000" stroke-width="1.5"/>
      ${nodeLabel(cx(i), ny + nh / 2, st.name + (st.n === 4 ? '*' : ''))}`;
    if (i < 7) g += `<line x1="${cx(i) + NW / 2}" y1="${ny + nh / 2}" x2="${cx(i + 1) - NW / 2 - 1}" y2="${ny + nh / 2}" stroke="#000" stroke-width="1.5" marker-end="url(#ah)"/>`;
    if (st.input) g += `<rect x="${cx(i) - 58}" y="200" width="116" height="30" rx="4" fill="#fff" stroke="#A36A00" stroke-dasharray="4 3"/>
      <text x="${cx(i)}" y="219" class="fi">${st.input}</text><line x1="${cx(i)}" y1="199" x2="${cx(i)}" y2="${ny + nh + 3}" stroke="#A36A00" stroke-width="1.5" marker-end="url(#ahg)"/>`;
  });
  // harness optimization (above) and RL optimization (below) between steps 3 and 4
  g += `<path d="M${cx(2)},${ny - 2} C${cx(2) + 20},${ny - 46} ${cx(3) - 20},${ny - 46} ${cx(3)},${ny - 2}" fill="none" stroke="#EE0000" stroke-width="1.6" marker-end="url(#ahr)"/>
    <text x="${(cx(2) + cx(3)) / 2}" y="${ny - 44}" class="fo">Harness optimization</text>
    <path d="M${cx(2)},${ny + nh + 2} C${cx(2) + 20},${ny + nh + 46} ${cx(3) - 20},${ny + nh + 46} ${cx(3)},${ny + nh + 2}" fill="none" stroke="#EE0000" stroke-width="1.6" marker-end="url(#ahr)"/>
    <text x="${cx(3) + 14}" y="${ny + nh + 50}" class="fo" text-anchor="start">RL optimization</text>
    <text x="${cx(3) + 14}" y="${ny + nh + 65}" class="fo" text-anchor="start">PPO · DPO · GRPO</text>`;
  // iterate on regressions: step 7 back to step 5
  g += `<path d="M${cx(6)},${ny + nh + 2} C${cx(6) - 40},${ny + nh + 70} ${cx(4) + 40},${ny + nh + 70} ${cx(4)},${ny + nh + 2}" fill="none" stroke="#555" stroke-width="1.6" stroke-dasharray="6 4" marker-end="url(#ahg)"/>
    <text x="${cx(5)}" y="${ny + nh + 70}" class="fg">Iterate on regressions</text>`;
  // demo tool chips (links into the app)
  const chip = (x, y, label, href, cls, ext) => `<a href="${href}"${ext ? ' target="_blank" rel="noopener"' : ''} class="fchip ${cls}"><rect x="${x - NW / 2}" y="${y}" width="${NW}" height="22" rx="5"/><text x="${x}" y="${y + 15}">${label}</text></a>`;
  FLOW_STEPS.forEach((st, i) => {
    const top = 257 + (118 - st.tools.length * 28) / 2 + 3;
    st.tools.forEach(([k, l], j) => { g += chip(cx(i), top + j * 28, l, `#/${k}`, 'tool'); });
  });
  g += `<text x="${cx(3)}" y="368" class="fnote">*RL optimization only</text>`;
  // examples
  g += chip(cx(2), 395, 'Intent was missed', '#/rootcause', 'ex') + chip(cx(2), 422, 'B-001 · F-1, etc.', '#/fixes/B-001/F-1', 'ex');
  // code chips (GitHub links)
  const repo = S.boot.git.url;
  FLOW_STEPS.forEach((st, i) => {
    if (i > 3) return;
    const top = i === 0 ? 470 : 522 - (st.code.length - 1) * 14;
    st.code.forEach((f, j) => { g += chip(cx(i), top + j * 27, f.split('/').pop(), `${repo}/blob/main/${f}`, 'code', true); });
  });
  g += `<line x1="${cx(0) + NW / 2 + 2}" y1="${470 + 2 * 27 + 11}" x2="${cx(1) - NW / 2 - 3}" y2="${470 + 2 * 27 + 11}" stroke="#00752F" stroke-width="1.5" marker-end="url(#ahc)"/>
    <text x="${cx(1)}" y="${522 - 7}" class="fc">evaluator score</text>`;
  return `<div class="flow-wrap"><svg class="flow" viewBox="0 0 ${W} 614" role="img" aria-labelledby="flowt"><title id="flowt">Evaluation-driven improvement flow: from failed traces to staged rollout</title>${g}</svg></div>`;
}

async function vIntro() {
  crumbs([['Introduction']]);
  let live = null;
  try { live = await api('/api/overview/billing?range=30d'); } catch (e) { /* page still renders */ }
  const tool = ([k, l]) => `<a href="#/${k}">${esc(l.replace('*', ''))}</a>`;
  const groups = [];
  NAV.forEach(([k, l]) => { if (k === 'label') groups.push({ name: l, items: [] }); else if (k !== 'sep' && k !== 'intro' && groups.length) groups[groups.length - 1].items.push([k, l]); });
  const PURPOSE = {
    overview: 'KPIs, flagged-session rate with release markers, detection signals and themes for a traffic window.',
    themes: 'Failure clusters with severity, trend, evidence and sub-clusters.', fixes: 'Per-fix diff, before/after conversation replay, offline validation and delivery (including GitHub pull requests).',
    approvals: 'Risk-based routing to approvers, decisions, and the staged rollout with auto-rollback.', experiments: 'Side-by-side candidates on shared held-out scenarios, with Holm correction and a reward-hacking check.',
    optimizer: 'Reflective harness search and RL fine-tuning (GRPO, REINFORCE, DPO) with live curves.', regression: 'Themes turned into tests; suite runs and the release gate.',
    release: 'How approval routing, the regression gate and rollout stages decide what ships.', judges: 'How the resolution judge scores, where it is wrong, and Cohen\'s κ against humans.',
    traces: 'Every trace: transcript, spans, evaluator verdicts, decisions, human labels and replay.',
    journey: 'Search any trace and follow it through every revision: transcript, tool calls, verdicts, approvals and GitHub.', evaluators: 'Judge agreement with humans, weekly drift, auto-pause and recalibration.',
    patterns: 'Proven fixes packaged for other agents with the same failure signature.', agents: 'Connected agents, integration levels and what each level allows.',
    audit: 'Append-only, SHA-256 hash-chained record of every action.', manifest: 'Content fingerprints for every harness version, for attestation.',
    statistics: 'Paired replays, bootstrap intervals and multiple-comparison correction, live.', rootcause: 'Which release started each theme, and how confident the engine is.',
    detection: 'The six signals that flag a trace and how traces are assigned to themes.', vcs: 'Live commits, pull requests and branches on GitHub, and whether the running code matches main.',
  };
  const k = live?.kpis;
  page(`${head('Harness Optimization Engine', 'An evaluation-driven improvement loop for Verizon\'s AI customer-care agents: from failed production traces to a safe, staged rollout.',
    `<a class="btn primary" href="#/overview">Open the overview</a><a class="btn" href="#/fixes/B-001/F-1">See a fix replayed</a>`)}
    <div class="panel intro-lead">
      <p>AI agents rarely fail because the model is weak. They fail because of the <b>harness</b> around it: a prompt line that rushes the customer, a tool that is called too early, a missing guardrail, or a judge that rewards the wrong thing. This app watches production traffic, finds those failures, works out which change caused them, proposes a fix, proves it offline and then walks it through approval, regression tests and a staged rollout, recording every step.</p>
      <p class="small muted" style="margin:0">Everything runs on a deterministic simulation of two agents (billing and network outage), so every number on every screen is reproducible and no model API key is needed.</p>
    </div>
    ${k ? kpis([{ v: num(k.traces), l: 'Billing traces analyzed (14 days)' }, { v: pct(k.flag_rate), l: 'Sessions flagged by any signal' }, { v: k.themes, l: 'Failure themes found', d: `${k.critical} critical` }, { v: k.waiting, l: 'Changes waiting for approval' }]) : ''}
    <div class="grid-2">
      <div class="panel"><h2>Goals</h2><ul class="intro-list">
        <li><b>Resolve more customer issues</b> by fixing the harness behaviour that causes repeat contacts and low CSAT.</li>
        <li><b>Find failures early and explain them</b>, instead of discovering them in complaints weeks later.</li>
        <li><b>Ship only changes that are proven</b> on held-out traffic, never on a hunch.</li>
        <li><b>Keep people in control</b>: risk-based approvals, frozen policy lines and a complete audit trail.</li></ul></div>
      <div class="panel"><h2>Objectives</h2><ul class="intro-list">
        <li>Flag failures from <b>six independent signals</b> and cluster them into themes with a root-cause hypothesis tied to a release.</li>
        <li>Validate every fix with a <b>paired bootstrap 95% interval</b> on the judge and the human-audited outcome.</li>
        <li>Use a judge as a reward only while its <b>Cohen's κ against humans is at least 0.70</b>.</li>
        <li>Release only past a <b>98% regression gate</b> with every policy test passing, then stage it with <b>automatic rollback</b> on a 1-point drop.</li>
        <li>Record every action in a <b>hash-chained audit log</b> and deliver code changes as <b>GitHub pull requests</b>.</li></ul></div>
    </div>
    <div class="panel"><div class="panel-head"><h2>The flow</h2><span class="small muted">Boxes in the Demo tool and Example rows open that page; Code boxes open the file on GitHub.</span></div>
      ${flowDiagram()}
      <div class="grid-2" style="margin-top:14px">
        <div><h3>Two ways to fix a root cause</h3><p class="small">After step 3 the engine can change the <b>harness</b> (prompt, tools, control flow, evaluator: fast, reviewable, reversible) or, for first-party agents, fine-tune an <b>RL adapter</b> on AI feedback with PPO, DPO or GRPO. Weight changes take a separate, stricter release path.</p></div>
        <div><h3>Iterate on regressions</h3><p class="small">If a candidate breaks a regression test at step 7, it goes back to experiments at step 5 with the failing tests attached, rather than shipping with a known break.</p></div>
      </div></div>
    <h2 style="margin:26px 0 12px">Each step</h2>
    <div class="steps-grid">${FLOW_STEPS.map(st => `<div class="panel step-card"><div class="step-n">Step ${st.n}</div><h3>${esc(st.name)}</h3>
      <p class="small">${esc(st.what)}</p>
      <div class="small"><span class="muted">In the app:</span> ${st.tools.map(tool).join(' · ')}</div>
      <div class="small" style="margin-top:4px"><span class="muted">Code:</span> ${st.code.map(f => ext(`${S.boot.git.url}/blob/main/${f}`, `<span class="mono">${esc(f.split('/').pop())}</span>`)).join(' ')}</div></div>`).join('')}</div>
    <h2 style="margin:26px 0 12px">Sections of the app</h2>
    <div class="grid-2">${groups.map(gr => `<div class="panel"><h2>${esc(gr.name)}</h2><table>${gr.items.map(([key, l]) => `<tr class="click" data-href="#/${key}"><td class="nowrap"><a href="#/${key}">${esc(l)}</a></td><td class="small muted">${esc(PURPOSE[key] || '')}</td></tr>`).join('')}</table></div>`).join('')}</div>
    <div class="panel"><h2>A five-minute tour</h2><ol class="steps">
      <li><a href="#/overview">Overview</a>: see the flagged-session rate jump when v14 was released.</li>
      <li><a href="#/themes">Failure themes</a>: open <i>Premature closure on billing disputes</i> and read the root cause.</li>
      <li><a href="#/fixes/B-001/F-1">Fix F-1</a>: replay the same customer before and after the fix, then run validation.</li>
      <li><a href="#/experiments">Experiments</a>: compare candidates and check the reward-hacking panel.</li>
      <li><a href="#/approvals">Approvals</a>: approve a change and advance it through the rollout stages.</li>
      <li><a href="#/vcs">Version control</a>: see the pull requests and whether the running code matches GitHub.</li></ol></div>`);
}

/* ------------------------------------------------------------------ trace journey */
const J_KIND = { production: 'Original', release: 'Release', fix: 'Fix', other: 'Other fix', experiment: 'Experiment' };
const J_VERDICT = { Original: '', Fixed: 'good', Regressed: 'bad', 'No change': '', 'Changed, same outcome': 'warn' };

function toolFlow(tools, base) {
  // tools added relative to the original run are marked; tools the original called but this run did not are struck out
  const left = {}; (base || []).forEach(t => { left[t.name] = (left[t.name] || 0) + 1; });
  const chips = tools.map(t => {
    const known = base && left[t.name] > 0; if (known) left[t.name]--;
    const args = Object.entries(t.args).map(([k, v]) => `${k}=${v}`).join(', ');
    return `<span class="jtool ${base && !known ? 'added' : ''}" title="${esc(t.result)}"><b>${esc(t.name)}</b>(${esc(args)}) <span class="faint">→ ${esc(t.result)}</span></span>`;
  });
  const gone = base ? Object.entries(left).flatMap(([n, c]) => Array(c).fill(`<span class="jtool removed"><b>${esc(n)}</b></span>`)) : [];
  return `<div class="jtools">${chips.join('<span class="jarrow">→</span>') || '<span class="faint small">No tool calls</span>'}${gone.length ? `<span class="small muted" style="margin-left:8px">no longer called:</span>${gone.join('')}` : ''}</div>`;
}

function jOutcome(o) {
  const b = (ok, yes, no) => `<span class="badge ${ok ? 'good' : 'bad'}">${ok ? yes : no}</span>`;
  return `<div class="chips">${b(o.resolved, 'Resolved (human audit)', 'Not resolved (human audit)')} ${b(o.judge_pass, `Judge pass · ${fx(o.judge_score)}`, `Judge fail · ${fx(o.judge_score)}`)}
    ${b(o.policy, 'Policy pass', 'Policy violation')} ${b(o.tool_sequence_ok, 'Tool order OK', 'Tool-order anomaly')}
    ${b(!o.repeat_contact, 'No repeat contact', 'Repeat contact')} <span class="badge">CSAT ${o.csat}</span> <span class="badge">${num(o.tokens)} tokens</span></div>`;
}

function jStage(sg, i, base) {
  const h = sg.harness, f = sg.fix, ap = sg.approval, g = sg.git;
  const gitHTML = g ? (g.pr ? `${ext(g.pr.url, `PR #${g.pr.number}`)} · branch ${ext(g.branch_url, esc(g.branch), 'mono')}${g.pr.commits.map(c => ` · ${ext(c.url, c.short, 'mono')}`).join('')}`
    : `<span class="muted">No pull request yet.</span> Planned branch <span class="mono">${esc(g.branch)}</span> · <a href="#/fixes/${f.bundle}/${f.id}">open it from the fix</a>`) : '';
  return `<div class="jstep v-${sg.verdict.replace(/[^A-Za-z]/g, '')}"><div class="jdot">${i}</div><div class="panel jcard">
    <div class="panel-head"><div><span class="badge purple">${J_KIND[sg.kind]}</span> <b>${esc(sg.title)}</b>${sg.when ? ` <span class="small muted">· ${esc(sg.when)}</span>` : ''}
      <div class="small muted" style="margin-top:3px">Harness <span class="mono">${esc(h.version)}</span> · ${esc(h.name)} · manifest <a class="mono" href="#/manifest">${h.manifest}</a>${h.has_adapter ? ' · RL adapter' : ''}${sg.note ? ` · ${esc(sg.note)}` : ''}</div></div>
      ${sg.verdict !== 'Original' ? `<span class="badge ${J_VERDICT[sg.verdict] ?? ''}" style="font-size:12.5px">${esc(sg.verdict)}</span>` : ''}</div>
    ${sg.signals && sg.signals.length ? `<div class="small" style="margin-bottom:8px"><span class="muted">Flagged by:</span> ${sg.signals.map(esc).join(' · ')}</div>` : ''}
    ${jOutcome(sg.outcome)}
    <h4 class="jh">Tool calls</h4>${toolFlow(sg.tools, i ? base : null)}
    ${sg.changed_decisions.length ? `<h4 class="jh">Decisions that changed</h4><ul class="small jlist">${sg.changed_decisions.map(c => `<li>${esc(c.decision)}: <s>${esc(c.before)}</s> → <b>${esc(c.after)}</b></li>`).join('')}</ul>` : ''}
    ${h.edits.length ? `<h4 class="jh">Harness edits vs the original</h4><ul class="small jlist">${h.edits.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
    ${f || ap || g ? `<div class="kv small" style="margin-top:10px">
      ${f ? `<span class="k">Fix</span><span><a href="#/fixes/${f.bundle}/${f.id}">${f.bundle} · ${f.id}</a> · ${status(f.status)} · ${esc(f.layer)} · ${esc(f.risk)} risk${f.lift ? ` · replay lift <b class="${cls(f.lift.diff)}">${pts(f.lift.diff)}</b> (${pts(f.lift.lo)} to ${pts(f.lift.hi)})` : ''}</span>` : ''}
      ${sg.experiment ? `<span class="k">Experiment</span><span><a href="#/experiments/${sg.experiment.id}">${esc(sg.experiment.id)}</a>${sg.experiment.recommended ? ' · <b>recommended</b>' : ''}</span>` : ''}
      ${ap ? `<span class="k">Approval</span><span><a href="#/approvals/${ap.id}">${ap.id}</a> · ${status(ap.status)}${ap.waiting_on ? ` · waiting on ${esc(ap.waiting_on)}` : ''}${ap.stage ? ` · stage ${esc(ap.stage)}` : ''}</span>` : ''}
      ${g ? `<span class="k">GitHub</span><span>${gitHTML}</span>` : ''}</div>` : ''}
    <details class="jtx"><summary>Transcript${sg.divergence >= 0 ? ` · differs from the original from message ${sg.divergence + 1}` : i ? ' · identical to the original' : ''}</summary>
      <div class="msgs" style="margin-top:10px;max-width:680px">${sg.messages.map((m, k) => msgHTML(m, i && sg.divergence >= 0 && k >= sg.divergence ? 'new' : '')).join('')}</div></details>
  </div></div>`;
}

function jResults(items, q) {
  if (!items.length) return empty('No traces match.');
  return `<table><tr><th>Trace</th><th>When</th><th>Harness</th><th>Scenario</th><th>Customer</th><th>Theme</th><th>Outcome</th></tr>
    ${items.map(t => `<tr class="click" data-href="#/journey/${t.id}${q ? `?q=${encodeURIComponent(q)}` : ''}"><td class="mono small"><a href="#/journey/${t.id}">${t.id}</a></td><td class="small nowrap">${esc(t.date)} ${esc(t.time)}</td>
      <td class="mono small">${esc(t.version)}</td><td class="small">${esc(t.label)}${t.why ? `<div class="pos small">${esc(t.why)}</div>` : ''}</td><td class="small muted">“${esc(t.snippet.slice(0, 60))}”</td>
      <td class="small">${t.theme ? esc(t.theme) : '<span class="faint">—</span>'}</td><td>${t.resolved ? '<span class="badge good">Resolved</span>' : '<span class="badge bad">Not resolved</span>'}</td></tr>`).join('')}</table>`;
}

async function vJourney(tid) {
  crumbs(tid ? [[NAV_GROUP('journey')], ['Trace journey', '#/journey'], [tid]] : [[NAV_GROUP('journey')], ['Trace journey']]);
  const q = S.query.get('q') || '';
  const a = S.boot.agents.find(x => x.id === S.agent);
  const searchBar = `<div class="panel"><div class="actions"><input type="text" id="jq" value="${esc(q)}" placeholder="Search by trace id, customer words, scenario, theme or version (e.g. tr_d74f, dispute, v13)" style="flex:1;min-width:280px">
    <button class="btn primary" data-act="jsearch">Search</button>${q ? '<a class="btn ghost" href="#/journey">Clear</a>' : ''}</div>
    <p class="small muted" style="margin:8px 0 0">Searches ${esc(a.name)} traces. Pick one to replay the same customer under every harness revision.</p></div>`;
  ACT.jsearch = () => { location.hash = `#/journey?q=${encodeURIComponent($('#jq').value.trim())}`; };
  const onEnter = () => { const el = $('#jq'); if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') ACT.jsearch(); }); };
  if (!tid) {
    const head_ = head('Trace journey', 'Follow one production trace through every revision the engine made: what the agent said, which tools it called, how it was judged, and where the fix went in GitHub.');
    if (!a.kind) { page(head_ + observeOnly(a)); return; }
    const r = await api(`/api/journey/search/${S.agent}?q=${encodeURIComponent(q)}`);
    page(`${head_}${searchBar}
      ${r.suggested.length ? `<div class="panel"><h2>Journeys worth opening</h2><p class="small muted">Traces that a proposed fix actually turns from not resolved into resolved.</p>${jResults(r.suggested, '')}</div>` : ''}
      <div class="panel"><div class="panel-head"><h2>${q ? `Matches for “${esc(q)}”` : 'Recent traces'}</h2><span class="small muted">${num(r.total)} trace${r.total === 1 ? '' : 's'}${r.total > r.items.length ? `, showing ${r.items.length}` : ''}</span></div>${jResults(r.items, q)}</div>`);
    onEnter(); return;
  }
  const d = await api(`/api/journey/${tid}`);
  const t = d.trace, st0 = d.stages[0], gp = d.git;
  ACT.jgo = el => document.getElementById(`js${el.dataset.i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const path = d.stages.map((sg, i) => `<a class="jpath ${J_VERDICT[sg.verdict] ?? ''}" role="button" tabindex="0" data-act="jgo" data-i="${i}"><span class="small faint">${i ? J_KIND[sg.kind] : 'Original'}</span><br><b class="mono">${esc(sg.fix ? `${sg.fix.bundle} · ${sg.fix.id}` : sg.kind === 'experiment' ? sg.harness.name.split(':')[0] : sg.harness.version)}</b> ${sg.outcome.resolved ? '✓' : '✗'}</a>`).join('<span class="jarrow">→</span>');
  page(`${head(`Trace journey · <span class="mono">${esc(t.id)}</span>`, `${esc(t.agent_name)} · ${esc(t.label)} · recorded ${esc(t.date)} ${esc(t.time)} on ${esc(t.version)}${d.theme ? ` · <a href="#/themes/${d.theme.id}">${esc(d.theme.name)}</a>` : ''}`,
      `<a class="btn" href="#/traces/${t.id}">Evidence explorer</a>${ext(gp.repo_url, 'Repository', 'btn')}`)}
    ${searchBar}
    <div class="panel"><div class="panel-head"><h2>Journey at a glance</h2><span class="small muted">${d.summary.candidates} revision${d.summary.candidates === 1 ? '' : 's'} replayed with the same customer and the same random draws</span></div>
      <div class="jpaths">${path}</div>
      <p class="small" style="margin:12px 0 0">${d.summary.first_fix ? `First fixed by <b>${esc(d.summary.first_fix)}</b>. ` : st0.outcome.resolved ? 'Resolved in production already; the journey checks that no revision breaks it. ' : 'No revision resolves this trace yet. '}
        ${d.summary.regressed_by.length ? `<span class="neg">Regressed by ${d.summary.regressed_by.map(esc).join('; ')}.</span>` : 'No revision regresses it.'}
        ${d.theme ? ` Root cause: ${esc(d.theme.root_cause)} <span class="muted">(confidence ${pct(d.theme.confidence, 0)})</span>` : ''}</p></div>
    <div class="grid-main"><div class="journey">${d.stages.map((sg, i) => `<div id="js${i}">${jStage(sg, i, st0.tools)}</div>`).join('')}</div>
    <div>
      <div class="panel"><h2>GitHub</h2>
        <div class="kv small"><span class="k">Repository</span><span>${ext(gp.repo_url, esc(gp.repo), 'mono')}</span>
          ${gp.main_head ? `<span class="k">main</span><span>${ext(gp.main_head.url, gp.main_head.sha, 'mono')} ${esc(gp.main_head.message)}</span>` : ''}
          ${gp.path ? `<span class="k">Harness files</span><span class="mono">${esc(gp.path)}/</span>` : ''}
          <span class="k">Pull requests</span><span>${gp.live ? 'live' : 'dry run (no token)'}</span></div>
        ${gp.note ? `<p class="small muted" style="margin-top:8px">${esc(gp.note)}</p>` : ''}
        ${gp.error ? `<div class="alert warn small" style="margin-top:8px"><div>${esc(gp.error)}</div></div>` : ''}
        ${gp.prs.length ? `<h3 style="margin:12px 0 6px">Fix branches</h3><table>${gp.prs.map(p => `<tr><td class="small">${esc(p.fix)}</td><td class="small">${p.pr ? ext(p.pr.url, `PR #${p.pr.number}`) : '<span class="faint">not opened</span>'}</td>
          <td class="small mono">${p.pr ? ext(p.branch_url, esc(p.branch)) : esc(p.branch)}</td></tr>`).join('')}</table>` : ''}
        ${gp.path ? `<h3 style="margin:12px 0 6px">Commits to ${esc(gp.path)}/</h3>${gp.commits.length ? `<table>${gp.commits.map(c => `<tr><td>${ext(c.url, c.sha, 'mono')}</td><td class="small">${esc(c.message)}<div class="faint">${esc(c.date)}</div></td></tr>`).join('')}</table>`
          : '<p class="small muted">None on main yet. The first merged HOE pull request creates these files.</p>'}` : ''}
        <a class="btn sm ghost" href="#/vcs" style="margin-top:6px">Version control</a></div>
      <div class="panel"><h2>Audit trail</h2>${d.audit.length ? `<table>${d.audit.map(r => `<tr><td class="small nowrap">${esc(r.time)}</td><td class="small">${esc(r.event)}<div class="faint">${esc(r.obj)}</div></td></tr>`).join('')}</table>` : empty('No audit events for this trace yet.')}</div>
    </div></div>`);
  onEnter();
}

/* ================================================================== shell */
const BASE_NAV = [['intro', 'Introduction'], ['label', 'Optimization Flow'], ['overview', 'Overview'], ['themes', 'Failure themes'], ['fixes', 'Fix bundles'], ['approvals', 'Approvals'],
  ['experiments', 'Experiments'], ['optimizer', 'Optimizer & RL'], ['regression', 'Regression suites'], ['release', 'Release'], ['judges', 'Judges'],
  ['label', 'Evaluation & Reporting'], ['traces', 'Evidence explorer'], ['journey', 'Trace journey'], ['evaluators', 'Evaluator health'], ['patterns', 'Pattern library'],
  ['agents', 'Agents & connections'], ['audit', 'Audit log'], ['gitdelta', 'Nightly versions & Git evidence'], ['manifest', 'Manifest hash'], ['statistics', 'Statistics'], ['rootcause', 'Root cause'],
  ['detection', 'Detection'], ['vcs', 'Version control']];
const BASE_SECTIONS = BASE_NAV.filter(([k]) => k !== 'label' && k !== 'sep' && k !== 'gitdelta');
const NAV = BASE_NAV.concat([['label', 'New Trace Mirror']]).concat(BASE_SECTIONS.map(([k, l]) => [`ingest/${k}`, `${l} (New Traces)`]));
const NAV_GROUP = key => { let g = ''; for (const [k, l] of NAV) { if (k === 'label') g = l; else if (k === key) return g; } return ''; };
const ROUTES = [[/^intro$/, vIntro], [/^overview$/, vOverview], [/^themes$/, vThemes], [/^themes\/(.+)$/, vTheme], [/^fixes$/, vFixes], [/^fixes\/([^/]+)\/([^/]+)$/, vFix],
  [/^approvals$/, vApprovals], [/^approvals\/(.+)$/, vApproval], [/^experiments$/, vExperiments], [/^experiments\/(.+)$/, vExperiment],
  [/^optimizer$/, vOptimizer], [/^regression$/, vRegression], [/^traces$/, vTraces], [/^traces\/(.+)$/, vTrace], [/^journey$/, vJourney], [/^journey\/(.+)$/, vJourney], [/^evaluators$/, vEvaluators],
  [/^patterns$/, vPatterns], [/^agents$/, vAgents], [/^audit$/, vAudit], [/^gitdelta$/, vGitDelta], [/^detection$/, vHoodDetection], [/^rootcause$/, vHoodRootCause],
  [/^statistics$/, vHoodStatistics], [/^judges$/, vHoodJudges], [/^release$/, vHoodRelease], [/^manifest$/, vHoodManifest], [/^vcs$/, vVcs], [/^ingest\/(.+)$/, vIngestMirror]];

const HOOD_KEYS = ['detection', 'rootcause', 'statistics', 'judges', 'release', 'manifest'];
const TOP_LABEL = { optimizer: 'Optimizer', regression: 'Regression', traces: 'Evidence', evaluators: 'Evaluators', patterns: 'Patterns', agents: 'Agents', vcs: 'Git', gitdelta: 'Nightly Git', intro: 'Intro', journey: 'Journey' };
function currentPath() { return location.hash.replace(/^#\/?/, '') || 'intro'; }
function isMirrorPath(path) { return (path || '').startsWith('ingest/'); }
function baseSectionFromPath(path) {
  const head = (path || '').split(/[?]/)[0];
  const parts = head.split('/').filter(Boolean);
  if (!parts.length) return 'overview';
  return parts[0] === 'ingest' ? (parts[1] || 'overview') : parts[0];
}
function compareTarget(mode, path) {
  const raw = path || currentPath();
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';
  const section = baseSectionFromPath(raw);
  return mode === 'mirror' ? `#/ingest/${section}${query}` : `#/${section}${query}`;
}
function renderTopNav(section) {
  const items = BASE_NAV.filter(([k]) => k !== 'sep' && k !== 'label' && k !== 'vcs' && !HOOD_KEYS.includes(k)).map(([k, l]) => [k, TOP_LABEL[k] || l])
    .concat([['detection', 'Under the hood'], ['vcs', TOP_LABEL.vcs]]);
  $('#topnav').innerHTML = items.map(([k, l], i) => {
    const on = k === section || (k === 'detection' && HOOD_KEYS.includes(section));
    return `<li><a href="#/${k}" class="${on ? 'active' : ''}" ${on ? 'aria-current="page"' : ''}><span class="n">${i + 1}</span> ${l}${k === 'approvals' && S.boot?.waiting ? `<span class="count">${S.boot.waiting}</span>` : ''}</a></li>`;
  }).join('');
  const cmp = $('#compare-toggle');
  if (cmp) {
    const path = currentPath();
    const onMirror = isMirrorPath(path);
    cmp.innerHTML = `<a class="${onMirror ? '' : 'on'}" href="${compareTarget('original', path)}">Original</a>
      <a class="${onMirror ? 'on' : ''}" href="${compareTarget('mirror', path)}">New Traces</a>`;
  }
  const reveal = () => {  // scroll only the tab strip, never the page
    const ul = $('#topnav'), a = $('#topnav a.active');
    if (!a) return;
    const l = a.offsetLeft - ul.offsetLeft, r = l + a.offsetWidth;
    if (l < ul.scrollLeft) ul.scrollLeft = l - 8; else if (r > ul.scrollLeft + ul.clientWidth) ul.scrollLeft = r - ul.clientWidth + 8;
  };
  reveal(); document.fonts?.ready.then(reveal);
}

function renderNav(section) {
  renderTopNav(section);
  $('#nav').innerHTML = NAV.map(([k, l], i) => k === 'sep' ? '<li class="sep" role="separator"></li>'
    : k === 'label' ? `${i ? '<li class="sep" role="separator"></li>' : ''}<li class="nav-label">${l}</li>`
    : `<li><a href="#/${k}" class="${k === section ? 'active' : ''}" ${k === section ? 'aria-current="page"' : ''}><span>${l}</span>${k === 'approvals' && S.boot?.waiting ? `<span class="count">${S.boot.waiting}</span>` : ''}</a></li>`).join('');
}

async function route() {
  S.timers.forEach(clearInterval); S.timers = []; clearInterval(S.jobTimer); ACT = {};
  const h = currentPath();
  const [path, qs] = h.split('?');
  S.query = new URLSearchParams(qs || '');
  renderNav(path.startsWith('ingest/') ? `ingest/${path.split('/')[1] || 'overview'}` : path.split('/')[0]);
  page('<div class="loading">Loading…</div>');
  for (const [re, fn] of ROUTES) {
    const m = path.match(re);
    if (m) {
      try { await fn(...m.slice(1).map(decodeURIComponent)); }
      catch (e) { page(`<div class="alert bad"><div>${esc(e.message)}</div><a class="btn sm" href="#/overview">Go to overview</a></div>`); }
      $('#main').focus({ preventScroll: true });
      return;
    }
  }
  location.hash = '#/overview';
}

async function refreshBoot() {
  S.boot = await api('/api/bootstrap');
  const sel = $('#agent');
  sel.innerHTML = S.boot.agents.map(a => `<option value="${a.id}" ${a.id === S.agent ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  $('#llm-state').innerHTML = `${S.boot.llm ? 'LLM proposer: connected' : 'LLM proposer: off (simulation only)'}<br>
    GitHub: ${ext(S.boot.git.url, esc(S.boot.git.repo))} · ${S.boot.git.live ? 'live PRs' : 'dry run'}`;
  const path = location.hash.replace(/^#\/?/, '');
  const head = path.split(/[?]/)[0];
  renderNav(head.startsWith('ingest/') ? `ingest/${head.split('/')[1] || 'overview'}` : (head.split('/')[0] || 'overview'));
  await refreshHealthPanel();
}

async function boot() {
  for (let i = 0; i < 30; i++) { try { await refreshBoot(); break; } catch (e) { await new Promise(r => setTimeout(r, 500)); } }
  $('#agent').addEventListener('change', e => {
    S.agent = e.target.value;
    const section = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]) || 'overview';
    const target = `#/${NAV.some(n => n[0] === section) ? section : 'overview'}`;
    if (location.hash !== target) location.hash = target; else route();
  });
  $('#reset').addEventListener('click', async e => {
    if (!confirm('Re-seed all demo data? Runs, approvals and labels from this session will be lost.')) return;
    e.target.disabled = true; e.target.textContent = 'Resetting…';
    await post('/api/reset'); S.jobs = {}; S.suiteRun = null; await refreshBoot();
    e.target.disabled = false; e.target.textContent = 'Reset demo data'; toast('Demo data re-seeded'); route();
  });
  window.addEventListener('hashchange', route);
  if (!S.healthTimer) S.healthTimer = setInterval(() => { refreshHealthPanel(); }, 20000);
  route();
}
boot();
