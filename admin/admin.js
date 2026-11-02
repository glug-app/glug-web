// =============================================================================
// glug admin: the /admin pages (analytics step 3 of 3)
// =============================================================================
//
// One page for Adit and Sadhana. It signs in with a phone code through
// supabase-js (the session is kept under the storage key "glug-admin") and then
// talks to ONE server, the admin-dashboard Edge Function in glug-app. Its
// contract is glug-app's supabase/functions/admin-dashboard/types.ts, and
// docs/architecture/ADMIN_DASHBOARD.md defines every figure. Two kinds of
// percentage arrive: the admin part's shares are fractions (0.6667) and the
// sheet part's percentages are 0 to 100 (66.7). Both show as "66.7%".
//
// SAFETY: every string from the API (names, report details, comment bodies,
// venue and wine names, typed food pairings) reaches the page through el()
// and add() below, which only ever create elements and text nodes. Nothing in
// this file assigns innerHTML or parses HTML. Chart labels are canvas data.
//
// LOCAL FIXTURE MODE: on localhost or 127.0.0.1 with ?fixture=1 the page skips
// sign-in and answers every action from admin/fixture.json, which is
// gitignored and never deployed.

import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config.js';

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/admin-dashboard`;
const FIXTURE = ['localhost', '127.0.0.1'].includes(location.hostname) &&
  new URLSearchParams(location.search).get('fixture') === '1';
const NA = 'n/a';
const EVENTS_PENDING = 'Starts with app version 1.0.1.';
const TZ = 'America/New_York';

// The views, in nav order. `data` says which answer a view is drawn from.
const VIEWS = [
  { id: 'reports', label: 'Reports', data: 'reports', render: viewReports },
  { id: 'overview', label: 'Overview', data: 'metrics', render: viewOverview },
  { id: 'investors', label: 'Investors', data: 'metrics', render: viewInvestors },
  { id: 'growth', label: 'Growth', data: 'metrics', render: viewGrowth },
  { id: 'engagement', label: 'Engagement', data: 'metrics', render: viewEngagement },
  { id: 'retention', label: 'Retention', data: 'metrics', render: viewRetention },
  { id: 'restaurants', label: 'Restaurants', data: 'metrics', render: viewRestaurants },
  { id: 'scans', label: 'Scans', data: 'metrics', render: viewScans },
  { id: 'catalog', label: 'Catalog', data: 'metrics', render: viewCatalog },
  { id: 'logging', label: 'Logging and taste', data: 'metrics', render: viewLogging },
  { id: 'testers', label: 'Testers', data: 'metrics', render: viewTesters },
  { id: 'feedback', label: 'Feedback', data: null, render: viewFeedback },
];
const DEFAULT_VIEW = 'overview';

const state = {
  me: null,
  includeInternal: false, // the "Hide internal accounts" switch is on by default
  metrics: null,
  metricsBusy: false,
  metricsError: null,
  reports: null,
  reportsBusy: false,
  reportsError: null,
  reportsNotice: null,
  reportsFilter: 'open',
  view: DEFAULT_VIEW,
  ranges: new Map(), // chart id -> '7' | '30' | '90' | 'all', kept across refreshes
  tables: new Map(), // table id -> { key, dir, query }, kept across refreshes
};
let metricsSeq = 0;
let reportsSeq = 0;

let root = null;
let sb = null; // the supabase-js client (none in fixture mode)
let shell = {}; // the live nodes of the signed-in page

// ── DOM: the only way anything reaches the page ─────────────────────────────

/** createElement with attributes, listeners (onclick: fn) and children.
 *  Strings become text nodes, never markup. */
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  return add(node, children);
}

function add(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.firstChild.remove();
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

const cls = (...names) => names.filter(Boolean).join(' ') || null;

// ── Formatting ──────────────────────────────────────────────────────────────

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function int(v) {
  return isNum(v) ? intFormat.format(v) : NA;
}

function dec(v, digits = 2) {
  return isNum(v) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(v) : NA;
}

/** An admin share, a fraction in [0, 1]. */
function share(v) {
  return isNum(v) ? `${(v * 100).toFixed(1)}%` : NA;
}

/** A sheet percentage, already 0 to 100. */
function pct(v) {
  return isNum(v) ? `${v.toFixed(1)}%` : NA;
}

function money(v) {
  return isNum(v) ? `$${dec(v, 2)}` : NA;
}

function signed(v, digits = 0) {
  if (!isNum(v)) return NA;
  const text = Math.abs(v).toFixed(digits);
  return v > 0 ? `+${text}` : v < 0 ? `−${text}` : text;
}

function plural(n, one, many) {
  return `${int(n)} ${n === 1 ? one : many}`;
}

function hours(v) {
  return isNum(v) ? `${dec(v, 1)} ${v === 1 ? 'hour' : 'hours'}` : NA;
}

function duration(seconds) {
  if (!isNum(seconds)) return NA;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

function ms(v) {
  if (!isNum(v)) return NA;
  return v >= 1000 ? `${dec(v / 1000, 1)} s` : `${int(v)} ms`;
}

function ageText(h) {
  if (!isNum(h)) return NA;
  if (h < 1) return 'less than an hour ago';
  if (h < 48) {
    const n = Math.floor(h);
    return `${n} ${n === 1 ? 'hour' : 'hours'} ago`;
  }
  return `${Math.floor(h / 24)} days ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A New York calendar date "2026-10-27" as "Oct 27". */
function day(d) {
  const m = typeof d === 'string' ? ISO_DAY.exec(d) : null;
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : NA;
}

function dayYear(d) {
  const m = typeof d === 'string' ? ISO_DAY.exec(d) : null;
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : NA;
}

/** The server's window and note strings carry ISO dates; show them like the rest. */
function prettyDates(text) {
  return String(text ?? '').replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => day(d));
}

const stampFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const stampZoneFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

/** An ISO instant in New York time, the time zone of every date the server sends. */
function stamp(iso, withZone = false) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return NA;
  return (withZone ? stampZoneFormat : stampFormat).format(new Date(t));
}

function addDays(d, n) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

function mondayOf(d) {
  const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
  return addDays(d, -((weekday + 6) % 7));
}

// ── The server ──────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, code) {
    super(`${code} (${status})`);
    this.status = status;
    this.code = code;
  }
}

/** Thrown after a 401 has signed the page out, so callers stop quietly. */
class SignedOut extends Error {}

function errorText(e) {
  if (!(e instanceof ApiError)) return 'an error in the page';
  if (e.status === 0) return 'no connection';
  return `${e.code}, ${e.status}`;
}

/** POST one action. Exactly three headers: the token, the anon key and the
 *  content type. A custom header would fail the function's CORS preflight. */
async function call(body) {
  if (FIXTURE) return fixtureCall(body);
  const { data } = await sb.auth.getSession(); // refreshes the token when it is about to run out
  const token = data?.session?.access_token;
  if (!token) {
    await endSession('Sign in to continue.');
    throw new SignedOut();
  }
  let res;
  try {
    res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error');
  }
  if (res.status === 401) {
    await endSession('Your session ended. Sign in again.');
    throw new SignedOut();
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) throw new ApiError(res.status, typeof json?.error === 'string' ? json.error : 'server_error');
  if (json === null || typeof json !== 'object') throw new ApiError(res.status, 'bad_answer');
  return json;
}

// ── Local fixture mode ──────────────────────────────────────────────────────

let fixture = null;

/** Answers like the function, from admin/fixture.json, so every view and the
 *  review buttons can be checked without a login. */
async function fixtureCall(body) {
  if (!fixture) {
    const res = await fetch(new URL('./fixture.json', import.meta.url), { cache: 'no-store' });
    if (!res.ok) throw new ApiError(res.status, 'fixture_missing');
    fixture = await res.json();
  }
  const copy = (v) => structuredClone(v);
  switch (body.action) {
    case 'whoami':
      return copy(fixture.whoami);
    case 'metrics':
      return copy(body.include_internal === true ? fixture.metricsWithInternal ?? fixture.metrics : fixture.metrics);
    case 'reports': {
      const all = fixture.reports.reports;
      const open = all.filter((r) => r.reviewed_at === null);
      const filter = body.filter ?? 'open';
      return {
        filter,
        reports: copy(filter === 'all' ? all : open),
        truncated: fixture.reports.truncated === true,
        open_count: open.length,
        overdue_count: open.filter((r) => r.overdue).length,
      };
    }
    case 'review_report': {
      const row = fixture.reports.reports.find((r) => r.id === body.report_id);
      if (!row) throw new ApiError(404, 'report_not_found');
      row.reviewed_at = body.reviewed ? new Date().toISOString() : null;
      row.reviewer_name = body.reviewed ? fixture.whoami.display_name : null;
      row.overdue = !body.reviewed && row.age_hours > 24;
      return { report: copy(row) };
    }
    default:
      throw new ApiError(400, 'unknown_action');
  }
}

// ── Signing in and out ──────────────────────────────────────────────────────

let ending = null;

/** Sign out on this device only (scope "local") and show the sign-in form. */
function endSession(message) {
  if (!ending) {
    ending = (async () => {
      state.me = null;
      try {
        await sb?.auth.signOut({ scope: 'local' });
      } catch {
        // the local session is cleared even when the server cannot be reached
      }
      resetData();
      if (FIXTURE) location.assign(location.pathname);
      else renderSignIn(message);
    })().finally(() => {
      ending = null;
    });
  }
  return ending;
}

function resetData() {
  Object.assign(state, {
    metrics: null, metricsBusy: false, metricsError: null,
    reports: null, reportsBusy: false, reportsError: null, reportsNotice: null,
  });
  metricsSeq += 1;
  reportsSeq += 1;
}

/** A phone number as E.164. US numbers can be typed as they are; any other
 *  country takes its code in the first box, or a full number starting with +. */
function toE164(codeRaw, numberRaw) {
  const typed = numberRaw.trim();
  if (typed.startsWith('+') || typed.startsWith('00')) {
    const digits = typed.replace(/\D/g, '').replace(/^00/, '');
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const code = codeRaw.replace(/\D/g, '');
  let national = typed.replace(/\D/g, '');
  if (!code || !national) return null;
  if (code === '1') {
    if (national.length === 11 && national.startsWith('1')) national = national.slice(1);
    if (national.length !== 10) return null;
  } else {
    national = national.replace(/^0/, ''); // the trunk 0 most countries dial at home
  }
  const all = code + national;
  return all.length >= 8 && all.length <= 15 ? `+${all}` : null;
}

function renderSignIn(message = '') {
  teardown();
  let phone = null;

  const msg = el('p', { class: 'form-msg', role: 'status' });
  const say = (text, isError = false) => {
    msg.textContent = text;
    msg.classList.toggle('is-error', isError);
  };

  const countryCode = el('input', {
    class: 'input', id: 'signin-cc', type: 'text', inputmode: 'tel', autocomplete: 'tel-country-code',
    value: '+1', maxlength: '6', 'aria-label': 'Country code',
  });
  const number = el('input', {
    class: 'input', id: 'signin-phone', type: 'tel', autocomplete: 'tel-national', required: true,
  });
  const sendButton = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Send code');
  const phoneForm = el('form', { class: 'signin-form', novalidate: true },
    el('div', { class: 'field' },
      el('label', { for: 'signin-phone' }, 'Phone number'),
      el('div', { class: 'phone-row' }, countryCode, number),
      el('small', { class: 'hint' }, 'For a number outside the US, change +1 to its country code.'),
    ),
    sendButton,
  );

  const code = el('input', {
    class: 'input code-input', id: 'signin-code', type: 'text', inputmode: 'numeric',
    autocomplete: 'one-time-code', maxlength: '6', required: true,
  });
  const sentTo = el('p', { class: 'hint' });
  const verifyButton = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign in');
  const resendButton = el('button', { class: 'link-btn', type: 'button' }, 'Send a new code');
  const backButton = el('button', { class: 'link-btn', type: 'button' }, 'Use a different number');
  const codeForm = el('form', { class: 'signin-form', novalidate: true, hidden: true },
    sentTo,
    el('div', { class: 'field' }, el('label', { for: 'signin-code' }, '6-digit code'), code),
    verifyButton,
    el('div', { class: 'signin-alt' }, resendButton, backButton),
  );

  const busy = (on) => {
    for (const b of [sendButton, verifyButton, resendButton, backButton]) b.disabled = on;
  };

  async function send() {
    const e164 = phone ?? toE164(countryCode.value, number.value);
    if (!e164) {
      say('Enter the whole phone number. For a number outside the US, change +1 to its country code.', true);
      number.focus();
      return;
    }
    busy(true);
    say('Sending the code');
    let error = null;
    try {
      ({ error } = await sb.auth.signInWithOtp({ phone: e164, options: { shouldCreateUser: false } }));
    } catch (e) {
      error = e;
    }
    busy(false);
    if (error) {
      say(`The code was not sent. ${error.message ?? ''}`.trim(), true);
      return;
    }
    phone = e164;
    sentTo.textContent = `A code is on its way to ${e164}.`;
    phoneForm.hidden = true;
    codeForm.hidden = false;
    say('');
    code.value = '';
    code.focus();
  }

  phoneForm.addEventListener('submit', (e) => {
    e.preventDefault();
    phone = null;
    send();
  });
  resendButton.addEventListener('click', send);
  backButton.addEventListener('click', () => {
    phone = null;
    codeForm.hidden = true;
    phoneForm.hidden = false;
    say('');
    number.focus();
  });
  codeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = code.value.replace(/\D/g, '');
    if (token.length !== 6) {
      say('Enter the 6-digit code from the text message.', true);
      code.focus();
      return;
    }
    busy(true);
    say('Checking the code');
    let result;
    try {
      result = await sb.auth.verifyOtp({ phone, token, type: 'sms' });
    } catch (err) {
      result = { data: null, error: err };
    }
    busy(false);
    if (result.error || !result.data?.session) {
      say(`That code did not work. ${result.error?.message ?? ''}`.trim(), true);
      code.select();
      return;
    }
    startDashboard();
  });

  say(message);
  root.append(el('main', { class: 'gate' },
    el('div', { class: 'gate-card' }, el('h1', { class: 'gate-title' }, 'glug admin'), phoneForm, codeForm, msg),
  ));
  number.focus();
}

function renderGate(...children) {
  teardown();
  root.append(el('main', { class: 'gate' },
    el('div', { class: 'gate-card' }, el('h1', { class: 'gate-title' }, 'glug admin'), ...children),
  ));
}

function renderNotAdmin() {
  renderGate(
    el('p', {}, 'This account is not an admin.'),
    el('div', { class: 'gate-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => endSession('') }, 'Sign out')),
  );
}

async function startDashboard() {
  renderGate(el('p', { class: 'loading' }, 'Loading'));
  let me;
  try {
    me = await call({ action: 'whoami' });
  } catch (e) {
    if (e instanceof SignedOut) return;
    if (e.status === 403) {
      renderNotAdmin();
      return;
    }
    renderGate(
      el('p', {}, `The admin server did not answer (${errorText(e)}).`),
      el('div', { class: 'gate-actions' },
        el('button', { class: 'btn btn-primary', type: 'button', onclick: startDashboard }, 'Try again'),
        el('button', { class: 'btn', type: 'button', onclick: () => endSession('') }, 'Sign out')),
    );
    return;
  }
  state.me = me;
  buildShell();
  route();
  refresh();
}

// ── Loading the data ────────────────────────────────────────────────────────

/** `metrics` reads every table in full, so it runs on load and on Refresh only. */
async function loadMetrics() {
  const seq = ++metricsSeq;
  state.metricsBusy = true;
  state.metricsError = null;
  updateChrome();
  try {
    const answer = await call({ action: 'metrics', include_internal: state.includeInternal });
    if (seq !== metricsSeq) return;
    state.metrics = answer;
  } catch (e) {
    if (e instanceof SignedOut || seq !== metricsSeq) return;
    if (e.status === 403) {
      renderNotAdmin();
      return;
    }
    state.metricsError = e;
  } finally {
    if (seq === metricsSeq) state.metricsBusy = false;
  }
  if (!shell.main) return;
  updateChrome();
  if (currentView().data === 'metrics') renderView();
}

async function loadReports() {
  const seq = ++reportsSeq;
  state.reportsBusy = true;
  state.reportsError = null;
  updateChrome();
  try {
    const answer = await call({ action: 'reports', filter: state.reportsFilter });
    if (seq !== reportsSeq) return;
    state.reports = answer;
  } catch (e) {
    if (e instanceof SignedOut || seq !== reportsSeq) return;
    if (e.status === 403) {
      renderNotAdmin();
      return;
    }
    state.reportsError = e;
  } finally {
    if (seq === reportsSeq) state.reportsBusy = false;
  }
  if (!shell.main) return;
  updateChrome();
  if (currentView().data === 'reports') renderView();
}

function refresh() {
  loadMetrics();
  loadReports();
}

function toggleInternal() {
  state.includeInternal = !state.includeInternal;
  loadMetrics();
}

// ── The signed-in page: header, nav, main ───────────────────────────────────

function teardown() {
  destroyCharts();
  shell = {};
  clear(root);
}

function buildShell() {
  teardown();
  shell.generated = el('span', { class: 'generated' });
  shell.switch = el('button', { class: 'switch', type: 'button', role: 'switch', onclick: toggleInternal },
    el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-knob' })),
    el('span', {}, 'Hide internal accounts'),
  );
  shell.refresh = el('button', { class: 'btn', type: 'button', onclick: refresh }, 'Refresh');
  const name = (typeof state.me?.display_name === 'string' && state.me.display_name.trim()) || 'Admin';

  const header = el('header', { class: 'top' },
    el('div', { class: 'top-brand' },
      el('span', { class: 'brand' }, 'glug admin'),
      FIXTURE && el('span', { class: 'chip' }, 'Fixture')),
    el('div', { class: 'top-data' }, shell.generated, el('div', { class: 'top-controls' }, shell.switch, shell.refresh)),
    el('div', { class: 'top-user' },
      el('span', { class: 'who' }, name),
      el('button', { class: 'btn', type: 'button', onclick: () => endSession('') }, 'Sign out')),
  );

  shell.badge = el('span', { class: 'badge', 'aria-hidden': 'true', hidden: true });
  shell.badgeText = el('span', { class: 'visually-hidden' });
  shell.links = new Map();
  shell.nav = el('nav', { class: 'views', 'aria-label': 'Views' }, VIEWS.map((v) => {
    const link = el('a', { class: 'view-link', href: `#${v.id}` },
      el('span', {}, v.label),
      v.id === 'reports' && [shell.badge, shell.badgeText]);
    shell.links.set(v.id, link);
    return link;
  }));
  shell.main = el('main', { class: 'main', id: 'main', tabindex: '-1' });

  root.append(el('div', { class: 'shell' }, header, shell.nav, shell.main));
  updateChrome();
}

function currentView() {
  return VIEWS.find((v) => v.id === state.view) ?? VIEWS[1];
}

function route() {
  const id = location.hash.slice(1);
  state.view = VIEWS.some((v) => v.id === id) ? id : DEFAULT_VIEW;
  renderView();
  // keep the current tab in sight in the phone tab row
  const link = shell.links.get(state.view);
  const nav = shell.nav;
  if (link && nav.scrollWidth > nav.clientWidth) {
    nav.scrollLeft = link.offsetLeft - (nav.clientWidth - link.offsetWidth) / 2;
  }
}

/** The header, the nav state and the Reports badge, from whatever is loaded. */
function updateChrome() {
  if (!shell.main) return;
  const m = state.metrics;
  shell.generated.textContent = m
    ? `${state.metricsBusy ? 'Refreshing. ' : ''}Data from ${stamp(m.generatedAt, true)}`
    : state.metricsBusy ? 'Loading data' : 'No data loaded';
  shell.switch.setAttribute('aria-checked', String(!state.includeInternal));
  shell.refresh.disabled = state.metricsBusy || state.reportsBusy;

  const open = state.reports?.open_count ?? m?.admin?.reports?.open ?? 0;
  const overdue = state.reports?.overdue_count ?? m?.admin?.reports?.overdue ?? 0;
  shell.badge.hidden = !(open > 0);
  shell.badge.textContent = open > 0 ? int(open) : '';
  shell.badge.classList.toggle('is-overdue', overdue > 0);
  shell.badgeText.textContent = open > 0
    ? `, ${int(open)} open${overdue > 0 ? `, ${int(overdue)} over 24 hours` : ''}`
    : '';

  for (const [id, link] of shell.links) {
    if (id === state.view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const view = currentView();
  const refetching = (view.data === 'metrics' && state.metricsBusy && state.metrics !== null) ||
    (view.data === 'reports' && state.reportsBusy && state.reports !== null);
  shell.main.classList.toggle('is-busy', refetching); // the old figures stay, dimmed, until the new ones land
}

function renderView() {
  if (!shell.main) return;
  destroyCharts();
  shell.reportsSummary = null;
  const view = currentView();
  const body = [el('h1', { class: 'view-title' }, view.label)];
  if (view.data === 'metrics') {
    if (state.metricsError) {
      body.push(problem(
        state.metrics
          ? `The last refresh failed (${errorText(state.metricsError)}). These figures are from ${stamp(state.metrics.generatedAt)}.`
          : `The figures did not load (${errorText(state.metricsError)}).`,
        loadMetrics,
      ));
    }
    if (state.metrics) body.push(view.render(state.metrics));
    else if (!state.metricsError) body.push(loading());
  } else {
    body.push(view.render());
  }
  clear(shell.main);
  add(shell.main, body);
  mountCharts();
  updateChrome();
}

// ── Building blocks ─────────────────────────────────────────────────────────

function card(title, ...children) {
  return el('section', { class: 'card' }, title && el('h2', { class: 'card-title' }, title), children);
}

function intro(text) {
  return el('p', { class: 'view-intro' }, text);
}

function note(text) {
  return el('p', { class: 'note' }, text);
}

function subTitle(text) {
  return el('h3', { class: 'sub-title' }, text);
}

function loading() {
  return el('p', { class: 'loading' }, 'Loading');
}

function empty(text) {
  return el('p', { class: 'empty' }, text);
}

function problem(text, retry) {
  return el('div', { class: 'notice is-error', role: 'alert' },
    el('p', {}, text),
    retry && el('button', { class: 'btn', type: 'button', onclick: retry }, 'Try again'));
}

/** What an events-basis chart or matrix shows while app_events is empty. */
function pending(label) {
  return el('p', { class: 'pending' }, label && el('span', { class: 'pending-label' }, label), EVENTS_PENDING);
}

function hasEvents(m) {
  return m.admin.engagement.sessions.eventRows > 0 || m.admin.scope.preferredBasis === 'events';
}

function scopeNote(m) {
  const s = m.admin.scope;
  return s.includeInternal
    ? ' Internal accounts are counted.'
    : ` ${plural(s.internalAccounts, 'internal account is', 'internal accounts are')} left out.`;
}

function grid(n, ...children) {
  return el('div', { class: `grid-${n}` }, children);
}

function tiles(list) {
  return el('div', { class: 'tiles' }, list.filter(Boolean).map((t) => el('div', { class: 'tile' },
    el('div', { class: 'tile-label' }, t.label),
    el('div', { class: 'tile-value' }, t.value),
    t.sub && el('div', { class: 'tile-sub' }, t.sub),
  )));
}

function kv(rows) {
  return el('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
}

/** A segmented switch (7d / 30d / 90d / All, Open / All). */
function seg(label, options, current, onPick) {
  const group = el('div', { class: 'seg', role: 'group', 'aria-label': label });
  for (const [value, text] of options) {
    const button = el('button', { type: 'button', 'aria-pressed': String(value === current) }, text);
    button.addEventListener('click', () => {
      for (const other of group.children) other.setAttribute('aria-pressed', String(other === button));
      onPick(value);
    });
    group.append(button);
  }
  return group;
}

function barLine(value, max, text) {
  const fill = el('span', { class: 'bar-fill' });
  const width = max > 0 && isNum(value) ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  fill.style.width = `${width}%`; // CSSOM, which the page's style-src 'self' allows
  return el('span', { class: 'bar-line' },
    el('span', { class: 'bar', 'aria-hidden': 'true' }, fill),
    el('span', { class: 'bar-text' }, text));
}

/** A few labelled counts with a bar and their share of `total`. */
function breakdown(title, rows, total) {
  const max = Math.max(0, ...rows.map(([, v]) => (isNum(v) ? v : 0)));
  return el('div', { class: 'breakdown' },
    title && subTitle(title),
    el('div', { class: 'table-wrap' }, el('table', { class: 'data' }, el('tbody', {}, rows.map(([label, v]) => el('tr', {},
      el('th', { scope: 'row' }, label),
      el('td', { class: 'bar-cell num' }, barLine(v, max, int(v))),
      el('td', { class: 'num muted' }, total > 0 && isNum(v) ? share(v / total) : NA),
    ))))));
}

/** A small fixed table: the first cell of each row is its header. A cell can
 *  be { span, text, cls } to run across several columns. */
function staticTable(headers, rows) {
  return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
    el('thead', {}, el('tr', {}, headers.map((h, i) => el('th', { scope: 'col', class: i > 0 ? 'num' : null }, h)))),
    el('tbody', {}, rows.map((row) => el('tr', {}, row.map((c, i) => {
      if (i === 0) return el('th', { scope: 'row' }, c);
      if (c && typeof c === 'object') return el('td', { colspan: c.span, class: c.cls ?? 'num' }, c.text);
      return el('td', { class: 'num' }, c);
    })))),
  ));
}

/**
 * A data table. Over 10 rows it sorts by clicking a header and, on phones,
 * scrolls inside its own box. `search` (row -> text) adds a search box.
 * Columns: { key, label, num?, bar?, wrap?, rowHeader?, value?(row), fmt?(v, row), cell?(row) }.
 */
function dataTable({ id, columns, rows, search, searchLabel = 'Search', emptyText = 'Nothing yet.', tableClass = 'data' }) {
  if (!rows || rows.length === 0) return empty(emptyText);
  let st = state.tables.get(id);
  if (!st) {
    st = { key: null, dir: 'desc', query: '' };
    state.tables.set(id, st);
  }
  const sortable = rows.length > 10;
  const valueOf = (col, row) => (col.value ? col.value(row) : row[col.key]);
  const maxes = new Map(columns.filter((c) => c.bar).map((c) => [c.key, Math.max(0, ...rows.map((r) => {
    const v = valueOf(c, r);
    return isNum(v) ? v : 0;
  }))]));

  const tbody = el('tbody');
  const count = el('span', { class: 'table-count', 'aria-live': 'polite' });
  const heads = columns.map((col) => {
    const th = el('th', { scope: 'col', class: cls(col.num && 'num') });
    if (!sortable) {
      th.textContent = col.label;
      return th;
    }
    const mark = el('span', { class: 'sort-mark', 'aria-hidden': 'true' });
    th.append(el('button', {
      type: 'button',
      class: 'sort-btn',
      onclick: () => {
        if (st.key === col.key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
        else {
          st.key = col.key;
          st.dir = col.num ? 'desc' : 'asc';
        }
        draw();
      },
    }, col.label, mark));
    return th;
  });

  function makeCell(col, row) {
    if (col.cell) return col.cell(row);
    const raw = valueOf(col, row);
    const text = col.fmt ? col.fmt(raw, row) : raw === null || raw === undefined || raw === '' ? NA : String(raw);
    const node = el(col.rowHeader ? 'th' : 'td', {
      class: cls(col.num && 'num', col.wrap && 'wrap', col.bar && 'bar-cell', col.cls),
      scope: col.rowHeader ? 'row' : null,
    });
    if (col.bar) node.append(barLine(raw, maxes.get(col.key), text));
    else node.textContent = text;
    return node;
  }

  function draw() {
    let list = rows;
    if (search && st.query.trim()) {
      const q = st.query.trim().toLowerCase();
      list = list.filter((r) => search(r).toLowerCase().includes(q));
    }
    if (sortable && st.key) {
      const col = columns.find((c) => c.key === st.key);
      if (col) list = sortRows(list, (r) => valueOf(col, r), st.dir);
    }
    clear(tbody);
    for (const row of list) tbody.append(el('tr', {}, columns.map((col) => makeCell(col, row))));
    if (list.length === 0) tbody.append(el('tr', {}, el('td', { class: 'empty', colspan: columns.length }, 'No matches.')));
    if (search) count.textContent = `${int(list.length)} of ${int(rows.length)}`;
    if (sortable) {
      columns.forEach((col, i) => {
        const on = st.key === col.key;
        if (on) heads[i].setAttribute('aria-sort', st.dir === 'asc' ? 'ascending' : 'descending');
        else heads[i].removeAttribute('aria-sort');
        const mark = heads[i].querySelector('.sort-mark');
        mark.textContent = on ? (st.dir === 'asc' ? '↑' : '↓') : '↕'; // a faint mark says the header sorts
        mark.classList.toggle('is-idle', !on);
      });
    }
  }

  const tools = search && el('div', { class: 'table-tools' },
    el('input', {
      class: 'input input-search', type: 'search', placeholder: searchLabel, 'aria-label': searchLabel,
      value: st.query,
      oninput: (e) => {
        st.query = e.target.value;
        draw();
      },
    }),
    count);
  draw();
  return el('div', { class: 'table-block' },
    tools,
    el('div', { class: cls('table-wrap', rows.length > 10 && 'is-long') },
      el('table', { class: tableClass }, el('thead', {}, el('tr', {}, heads)), tbody)));
}

/** Nulls sort last whichever way; numbers as numbers, text in natural order. */
function sortRows(list, get, dir) {
  return [...list].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    const xNone = x === null || x === undefined || x === '';
    const yNone = y === null || y === undefined || y === '';
    if (xNone || yNone) return xNone === yNone ? 0 : xNone ? 1 : -1;
    const cmp = typeof x === 'number' && typeof y === 'number'
      ? x - y
      : String(x).localeCompare(String(y), 'en', { numeric: true, sensitivity: 'base' });
    return dir === 'asc' ? cmp : -cmp;
  });
}

/** A cell shaded by its share, one hue light to dark (vine-olive). */
function shadeCell(node, amount) {
  node.style.backgroundColor = `rgba(70, 75, 54, ${(0.06 + 0.86 * amount).toFixed(3)})`;
  if (amount >= 0.5) node.classList.add('is-dark');
  return node;
}

/** A retention matrix: one row per weekly sign-up cohort, weeks 0 to 12. */
function retentionTable(id, cohorts, weekCount) {
  const weekColumns = Array.from({ length: weekCount }, (_, k) => ({
    key: `w${k}`,
    label: String(k),
    num: true,
    value: (c) => (isNum(c.weeks[k]) ? c.weeks[k] : null),
    cell: (c) => {
      const v = c.weeks[k];
      if (!isNum(v)) return el('td', { class: 'is-na' }, NA);
      return shadeCell(el('td', { title: share(v) }, `${Math.round(v * 100)}%`), v);
    },
  }));
  return dataTable({
    id,
    rows: cohorts,
    tableClass: 'heat',
    emptyText: 'No cohorts yet.',
    columns: [
      {
        key: 'weekStart',
        label: 'Cohort',
        cell: (c) => el('th', { scope: 'row', class: 'cohort' },
          el('span', { class: 'cohort-week' }, `Week of ${day(c.weekStart)}`),
          el('span', { class: 'cohort-size' }, plural(c.size, 'user', 'users'))),
      },
      ...weekColumns,
    ],
  });
}

// ── Charts ──────────────────────────────────────────────────────────────────

let C = {}; // chart colours, read from the CSS tokens at boot
let charts = [];
let pendingMounts = [];

// Every second series carries a dash pattern or markers as well as its colour.
const SERIES = [
  { color: 'olive', dash: [] },
  { color: 'wine', dash: [6, 4] },
  { color: 'sage', dash: [], points: true },
  { color: 'dust', dash: [2, 3], points: true },
];
const RANGES = [['7', '7d'], ['30', '30d'], ['90', '90d'], ['all', 'All']];
const RANGE_WORDS = { 7: 'last 7 days', 30: 'last 30 days', 90: 'last 90 days', all: 'all time' };

function readColors() {
  const css = getComputedStyle(document.documentElement);
  const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    olive: token('--vine-olive', '#464B36'),
    sage: token('--sage', '#6B6E56'),
    dust: token('--dust', '#C4C3B0'),
    ink: token('--ink', '#22251B'),
    bone: token('--bone', '#FBF8F0'),
    card: token('--card', '#FFFDF8'),
    wine: token('--wine-red', '#9B3D4B'),
    grid: 'rgba(34, 37, 27, 0.08)',
  };
}

function destroyCharts() {
  for (const chart of charts) chart.destroy();
  charts = [];
  pendingMounts = [];
}

/** Charts are drawn once their canvas is in the page and has a size. */
function mountCharts() {
  const list = pendingMounts;
  pendingMounts = [];
  for (const mount of list) mount();
}

const crosshair = {
  id: 'glugCrosshair',
  beforeDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() ?? [];
    if (active.length === 0) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.strokeStyle = C.dust;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(active[0].element.x, chartArea.top);
    ctx.lineTo(active[0].element.x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

/** The points that fall in a range, by the date each point ends on. */
function sliceRange(points, range, x) {
  if (range === 'all' || points.length === 0) return points;
  const endOf = (p) => (x === 'week' ? addDays(p.weekStart, 6) : p.date);
  const today = state.metrics?.admin?.scope?.today ?? endOf(points[points.length - 1]);
  const cutoff = addDays(today, -(Number(range) - 1));
  return points.filter((p) => endOf(p) >= cutoff);
}

function legend(series) {
  return el('ul', { class: 'legend' }, series.map((s, i) => el('li', {}, swatch(SERIES[s.style ?? i]), s.label)));
}

function swatch(style) {
  const svg = svgEl('svg', { width: 26, height: 10, viewBox: '0 0 26 10', 'aria-hidden': 'true', focusable: 'false' });
  const line = svgEl('line', {
    x1: 1, y1: 5, x2: 25, y2: 5, stroke: C[style.color], 'stroke-width': 2, 'stroke-linecap': 'round',
  });
  if (style.dash.length) line.setAttribute('stroke-dasharray', style.dash.join(' '));
  svg.append(line);
  if (style.points) svg.append(svgEl('circle', { cx: 13, cy: 5, r: 3.5, fill: C[style.color], stroke: C.card, 'stroke-width': 1.5 }));
  return svg;
}

/**
 * A time-series chart with its own 7d / 30d / 90d / All switch, sliced here.
 *   x       'day' (points carry `date`) or 'week' (points carry `weekStart`)
 *   type    'line', or 'bar' for one series (a partial week is the lighter bar)
 *   series  [{ label, value(point), style? }]: style is the SERIES slot, so a
 *           series keeps its colour and dash when another one is missing
 *   fmt     formats values in the tooltip and on the y axis
 *   extra   (point) -> more tooltip lines
 */
function chartCard(o) {
  const { id, title, x, type = 'line', points = [], series, fmt = int, extra, percent = false, notes = [] } = o;
  const range = state.ranges.get(id) ?? o.range ?? (x === 'day' ? '30' : 'all');
  const canvas = el('canvas', { role: 'img' });
  const box = el('div', { class: 'chart-box' }, canvas);
  const emptyNote = empty(o.emptyText ?? 'Nothing in this range.');
  emptyNote.hidden = true;
  let chart = null;
  let slice = [];

  const draw = (r) => {
    slice = sliceRange(points, r, x);
    canvas.setAttribute('aria-label', `${type === 'bar' ? 'Bar' : 'Line'} chart: ${title}, ${RANGE_WORDS[r]}.`);
    const has = slice.some((p) => series.some((s) => isNum(s.value(p))));
    box.hidden = !has;
    emptyNote.hidden = has;
    if (!has) return;
    const data = chartData(slice, x, type, series);
    if (chart) {
      chart.data = data;
      chart.update('none');
      return;
    }
    chart = new window.Chart(canvas, chartConfig({ type, data, x, fmt, percent, extra, getSlice: () => slice }));
    charts.push(chart);
  };
  pendingMounts.push(() => draw(range));

  return el('div', { class: 'chart' },
    el('div', { class: 'chart-head' },
      el('h3', { class: 'chart-title' }, title),
      seg(`Range for ${title}`, RANGES, range, (r) => {
        state.ranges.set(id, r);
        draw(r);
      })),
    (series.length > 1 || o.legend) && legend(series),
    box,
    emptyNote,
    notes);
}

function chartData(slice, x, type, series) {
  const labels = slice.map((p) => day(x === 'week' ? p.weekStart : p.date));
  const datasets = series.map((s, i) => {
    const style = SERIES[s.style ?? i];
    const color = C[style.color];
    const data = slice.map((p) => {
      const v = s.value(p);
      return isNum(v) ? v : null;
    });
    if (type === 'bar') {
      const fills = slice.map((p) => (p.partial ? C.dust : color));
      return {
        label: s.label, data, backgroundColor: fills, hoverBackgroundColor: fills,
        borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'start', maxBarThickness: 24,
        categoryPercentage: 0.9, barPercentage: 0.9,
      };
    }
    return {
      label: s.label, data, borderColor: color, backgroundColor: color, borderWidth: 2,
      borderDash: style.dash, borderCapStyle: 'round', borderJoinStyle: 'round', tension: 0, spanGaps: false, fill: false,
      pointRadius: style.points ? 3 : 0, pointHoverRadius: 4, pointHitRadius: 10,
      pointBackgroundColor: color, pointBorderColor: C.card, pointBorderWidth: style.points ? 1.5 : 1,
    };
  });
  return { labels, datasets };
}

function chartConfig({ type, data, x, fmt, percent, extra, getSlice }) {
  const yTicks = {
    color: C.sage, padding: 6, maxTicksLimit: 5, font: { size: 11 },
    callback: percent ? (v) => `${v}%` : (v) => fmt(v),
  };
  if (fmt === int) yTicks.precision = 0;
  const yScale = { beginAtZero: true, grid: { color: C.grid }, border: { display: false }, ticks: yTicks };
  if (percent) yScale.suggestedMax = 100;
  const pointAt = (items) => getSlice()[items[0]?.dataIndex];
  return {
    type,
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 6, right: 6 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: C.ink, titleColor: C.bone, bodyColor: C.bone, footerColor: C.dust,
          titleFont: { weight: '600' }, padding: 8, cornerRadius: 6, boxWidth: 8, boxHeight: 8, boxPadding: 4,
          callbacks: {
            title: (items) => {
              const p = pointAt(items);
              if (!p) return '';
              const label = x === 'week' ? `Week of ${day(p.weekStart)}` : day(p.date);
              return p.partial ? `${label}, so far` : label;
            },
            label: (item) => `${item.dataset.label}: ${isNum(item.raw) ? fmt(item.raw) : NA}`,
            afterBody: (items) => {
              const p = pointAt(items);
              return p && extra ? extra(p) : [];
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: C.grid },
          ticks: { color: C.sage, maxRotation: 0, autoSkip: true, autoSkipPadding: 16, font: { size: 11 } },
        },
        y: yScale,
      },
    },
    plugins: type === 'line' ? [crosshair] : [],
  };
}

/** Weekly rows that only list weeks with something in them, filled with zeros
 *  from the first week to `endWeek`, so the bars keep their real spacing. */
function fillWeeks(rows, key, endWeek) {
  if (rows.length === 0) return [];
  const byWeek = new Map(rows.map((r) => [r.weekStart, r[key]]));
  const last = [...byWeek.keys()].sort().at(-1);
  const stop = endWeek && endWeek > last ? endWeek : last;
  const thisWeek = state.metrics ? mondayOf(state.metrics.admin.scope.today) : null;
  const out = [];
  for (let w = [...byWeek.keys()].sort()[0]; w <= stop; w = addDays(w, 7)) {
    out.push({ weekStart: w, [key]: byWeek.get(w) ?? 0, partial: w === thisWeek });
  }
  return out;
}

// ── Reports ─────────────────────────────────────────────────────────────────

const REASONS = { spam: 'Spam', offensive: 'Offensive', harassment: 'Harassment', other: 'Other' };

function viewReports() {
  const r = state.reports;
  const out = [el('div', { class: 'view-tools' },
    seg('Which reports', [['open', 'Open'], ['all', 'All']], state.reportsFilter, (f) => {
      state.reportsFilter = f;
      state.reportsNotice = null;
      loadReports();
    }))];
  if (state.reportsNotice) out.push(el('p', { class: 'notice', role: 'status' }, state.reportsNotice));
  if (state.reportsError) out.push(problem(`The reports did not load (${errorText(state.reportsError)}).`, loadReports));
  if (!r) {
    if (!state.reportsError) out.push(loading());
    return out;
  }
  shell.reportsSummary = el('p', { class: 'view-intro' });
  writeReportsSummary();
  out.push(shell.reportsSummary);
  if (r.truncated) out.push(note('Only the newest 200 are shown. More reports match.'));
  out.push(r.reports.length
    ? el('div', { class: 'reports' }, r.reports.map(reportCard))
    : empty(r.filter === 'open' ? 'No open reports.' : 'No reports yet.'));
  return out;
}

function writeReportsSummary() {
  const r = state.reports;
  if (!r || !shell.reportsSummary) return;
  const counts = [`${int(r.open_count)} open`];
  if (r.overdue_count > 0) counts.push(`${int(r.overdue_count)} over 24 hours`);
  shell.reportsSummary.textContent =
    `${counts.join(', ')}. Showing ${r.filter === 'all' ? 'every report' : 'open reports'}, newest first.`;
}

function wineName(w) {
  return [w?.producer, w?.wine_name, w?.vintage].filter((s) => typeof s === 'string' && s.trim()).join(' ') || NA;
}

function field(label, ...value) {
  return el('div', { class: 'field-row' }, el('div', { class: 'field-label' }, label), el('div', { class: 'field-value' }, value));
}

function targetField(t) {
  switch (t?.kind) {
    case 'user':
      return field('Reported account',
        el('span', { class: 'target-main' }, t.display_name ?? NA),
        el('span', { class: 'target-meta' }, t.is_public ? 'Public profile' : 'Private profile'));
    case 'log': {
      const meta = [
        `By ${t.author_name ?? NA}`,
        t.rating && `Rated ${t.rating}`,
        t.venue_name && `At ${t.venue_name}`,
        t.visibility && (t.visibility === 'public' ? 'Public log' : 'Private log'),
      ].filter(Boolean).join(', ');
      return field('Reported log', el('span', { class: 'target-main' }, wineName(t)), el('span', { class: 'target-meta' }, meta));
    }
    case 'comment':
      return field('Reported comment',
        el('blockquote', { class: 'quote' }, t.body ?? ''),
        el('span', { class: 'target-meta' },
          `By ${t.author_name ?? NA}${t.wine ? `, on a log of ${wineName(t.wine)}` : ''}`));
    case 'deleted':
      return field('Reported item', el('span', { class: 'target-main' }, 'Deleted after the report was filed.'));
    default:
      return field('Reported item', NA);
  }
}

function reportCard(rep) {
  const reviewed = rep.reviewed_at !== null;
  const action = el('button', { class: reviewed ? 'btn' : 'btn btn-primary', type: 'button' }, reviewed ? 'Mark open' : 'Mark reviewed');
  const error = el('p', { class: 'form-msg is-error', role: 'alert', hidden: true });
  const status = reviewed
    ? rep.reviewer_name
      ? `Reviewed by ${rep.reviewer_name}, ${stamp(rep.reviewed_at)}`
      : `Reviewed ${stamp(rep.reviewed_at)}`
    : 'Open';
  const node = el('article', { class: cls('card', 'report', rep.overdue && 'is-overdue') },
    el('div', { class: 'report-head' },
      el('h2', { class: 'report-reason' }, REASONS[rep.reason] ?? 'Other'),
      el('span', { class: 'report-age', title: stamp(rep.created_at) }, `Filed ${ageText(rep.age_hours)}`),
      rep.overdue && el('span', { class: 'chip chip-alert' }, 'Over 24 hours')),
    targetField(rep.target),
    field('Details', rep.details ? el('p', { class: 'details' }, rep.details) : el('span', { class: 'muted' }, 'None given')),
    field('Reporter', rep.reporter_name ?? NA),
    el('div', { class: 'report-foot' }, el('p', { class: 'report-status' }, status), action),
    error);
  action.addEventListener('click', () => review(node, rep, !reviewed, action, error));
  return node;
}

/** review_report answers the authoritative row: the card is replaced with it. */
async function review(node, rep, reviewed, button, error) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Saving';
  error.hidden = true;
  try {
    const { report } = await call({ action: 'review_report', report_id: rep.id, reviewed });
    const r = state.reports;
    const i = r.reports.findIndex((x) => x.id === rep.id);
    if (i >= 0) r.reports[i] = report;
    if (rep.reviewed_at === null && report.reviewed_at !== null) {
      r.open_count = Math.max(0, r.open_count - 1);
      if (rep.overdue) r.overdue_count = Math.max(0, r.overdue_count - 1);
    } else if (rep.reviewed_at !== null && report.reviewed_at === null) {
      r.open_count += 1;
      if (report.overdue) r.overdue_count += 1;
    }
    const fresh = reportCard(report);
    node.replaceWith(fresh);
    fresh.querySelector('.report-foot .btn')?.focus();
    writeReportsSummary();
    updateChrome();
  } catch (e) {
    if (e instanceof SignedOut) return;
    if (e.status === 403) {
      renderNotAdmin();
      return;
    }
    if (e.status === 0 || e.status === 404 || e.status >= 500) {
      // The stamp can apply before an error (ADMIN_DASHBOARD.md section 9), so reload the list.
      state.reportsNotice = `The server did not confirm that change (${errorText(e)}). The list has been reloaded.`;
      loadReports();
      return;
    }
    button.disabled = false;
    button.textContent = label;
    error.textContent = `That did not save (${errorText(e)}).`;
    error.hidden = false;
  }
}

// ── Overview ────────────────────────────────────────────────────────────────

const NEW_IN_7_DAYS = new Set(['totalUsers', 'onboarded', 'logsTotal', 'menuScans', 'bottleScans', 'wantToTry', 'catalogSize', 'mintsPendingReview']);
const VS_PRIOR_7_DAYS = new Set(['active7d', 'logs7d', 'menuRows30d']);

function overviewTile(t) {
  const isPct = /Pct30d$/.test(t.key);
  let sub;
  if (!isNum(t.change7d)) sub = t.key === 'active30d' ? null : `7-day change: ${NA}`;
  else if (isPct) sub = `${signed(t.change7d, 1)} points against the 7 days before`;
  else if (NEW_IN_7_DAYS.has(t.key)) sub = `${signed(t.change7d)} in the last 7 days`;
  else if (VS_PRIOR_7_DAYS.has(t.key)) sub = `${signed(t.change7d)} against the 7 days before`;
  else sub = `7-day change: ${signed(t.change7d)}`;
  return { label: t.label, value: isPct ? pct(t.value) : int(t.value), sub };
}

function viewOverview(m) {
  const s = m.sheet;
  const days = s.trends.days;
  return [
    intro(`The figures of the glug dashboard sheet. It counts profiles, and a person is active on a day they log a wine, save a menu scan or scan a bottle.${scopeNote(m)}`),
    card('Totals', tiles(s.overview.tiles.map(overviewTile))),
    card('Daily trends', grid(2,
      chartCard({
        id: 'overview-people', title: 'People per day', x: 'day', points: days,
        series: [{ label: 'Active users', value: (d) => d.activeUsers }, { label: 'Sign-ups', value: (d) => d.signups }],
      }),
      chartCard({
        id: 'overview-actions', title: 'Logs and scans per day', x: 'day', points: days,
        series: [
          { label: 'Logs', value: (d) => d.logs },
          { label: 'Menu scans', value: (d) => d.menuScans },
          { label: 'Bottle scans', value: (d) => d.bottleScans },
        ],
      })),
      note('The sheet keeps the last 30 days.')),
  ];
}

// ── Investors ───────────────────────────────────────────────────────────────

const ratio = (v) => (isNum(v) ? v.toFixed(2) : NA);
const sentence = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);
const BASIS_LABELS = { 'deleted-accounts': 'deleted accounts' };

const INVESTOR_FIGURES = [
  ['totalUsers', 'Total users', int],
  ['avgWeeklySignups4w', 'Sign-ups per week, 4-week average', ratio],
  ['weeklyUserGrowthRate4w', 'Weekly user growth, 4-week average', share],
  ['waitlistSize', 'Waitlist', int],
  ['wau', 'Weekly active users', int],
  ['dauMau', 'DAU / MAU', share],
  ['week1Retention', 'Week 1 retention', share],
  ['week4Retention', 'Week 4 retention', share],
  ['scansPerWau', 'Scans per weekly active user', ratio],
  ['logsPerWau', 'Logs per weekly active user', ratio],
  ['venuesReached', 'Venues reached', int],
  ['restaurantLogShare', 'Logs with a venue', share],
  ['accountsDeleted', 'Accounts deleted', int],
];

function viewInvestors(m) {
  const inv = m.admin.investor;
  const basisNote = inv.basis === 'activity'
    ? 'Active users are counted by activity until the app sends events, then by events.'
    : 'Active users are counted by events.';
  return [
    intro(`${basisNote} As of ${dayYear(inv.asOf)}.${scopeNote(m)}`),
    el('div', { class: 'tiles tiles-figures' }, INVESTOR_FIGURES.map(([key, label, format]) => {
      const f = inv[key];
      if (!f) return null;
      return el('div', { class: 'tile' },
        el('div', { class: 'tile-label' }, label),
        el('div', { class: 'tile-value' }, format(f.value)),
        el('div', { class: 'tile-basis' }, `Basis: ${BASIS_LABELS[f.basis] ?? f.basis}`),
        el('div', { class: 'tile-sub' }, sentence(prettyDates(f.window))),
        f.note && el('div', { class: 'tile-sub' }, sentence(prettyDates(f.note))));
    })),
  ];
}

// ── Growth ──────────────────────────────────────────────────────────────────

function within(w) {
  return `${share(w.share)} (${int(w.hit)} of ${int(w.eligible)})`;
}

function viewGrowth(m) {
  const g = m.admin.growth;
  const w = g.waitlist;
  const itj = w.invitedToJoined;
  const a = m.admin.activation;
  const f = m.sheet.funnel;
  const thisWeek = g.signupsByWeek.at(-1);
  return [
    intro(`A user is a verified sign-up.${scopeNote(m)}`),
    card('Sign-ups',
      tiles([
        { label: 'Total users', value: int(g.totalUsers) },
        { label: 'First sign-up', value: dayYear(g.firstSignupDate) },
        thisWeek && { label: thisWeek.partial ? 'This week so far' : 'This week', value: int(thisWeek.signups) },
      ]),
      grid(2,
        chartCard({
          id: 'growth-weekly', title: 'Sign-ups per week', x: 'week', type: 'bar', points: g.signupsByWeek,
          series: [{ label: 'Sign-ups', value: (p) => p.signups }],
        }),
        chartCard({
          id: 'growth-total', title: 'Total users', x: 'week', points: g.signupsByWeek,
          series: [{ label: 'Total users', value: (p) => p.cumulative }],
        }))),
    card('Waitlist',
      tiles([
        { label: 'On the waitlist', value: int(w.total), sub: `Leaves out ${plural(w.excludedBackfilled, 'backfill row', 'backfill rows')}` },
        { label: 'Invited or joined', value: int(itj.invited) },
        { label: 'Joined', value: int(itj.joined) },
        { label: 'Invited who joined', value: share(itj.conversion) },
        { label: 'Days from invite to join', value: dec(itj.medianDays, 2), sub: `Median of ${plural(itj.medianBasis, 'row', 'rows')}` },
      ]),
      grid(3,
        breakdown('By status', [
          ['New', w.byStatus.new], ['Approved', w.byStatus.approved], ['Invited', w.byStatus.invited],
          ['Joined', w.byStatus.joined], ['Declined', w.byStatus.declined],
        ], w.total),
        breakdown('By source', [['Website', w.bySource.website], ['App', w.bySource.app], ['Not recorded', w.bySource.unknown]], w.total),
        breakdown('By platform', [['iOS', w.byPlatform.ios], ['Android', w.byPlatform.android], ['Unknown', w.byPlatform.unknown]], w.total)),
      note('The source is recorded from Nov 2, 2026, so earlier rows show as not recorded.'),
      chartCard({
        id: 'growth-waitlist', title: 'Waitlist joins per week', x: 'week', type: 'bar', points: w.joinsByWeek,
        series: [{ label: 'Joins', value: (p) => p.joins }],
        extra: (p) => [`Website: ${int(p.website)}`, `App: ${int(p.app)}`, `Not recorded: ${int(p.unknown)}`],
      })),
    card('Activation',
      tiles([
        { label: 'Users', value: int(a.users) },
        { label: 'Onboarded', value: share(a.onboarded.share), sub: `${int(a.onboarded.users)} of ${int(a.users)}` },
      ]),
      staticTable(['', 'Within 1 day', 'Within 7 days', 'Users who have', 'Median time to it'], [
        ['First scan', within(a.firstScan.within1Day), within(a.firstScan.within7Days), int(a.firstScan.users), hours(a.firstScan.medianHours)],
        ['First log', within(a.firstLog.within1Day), within(a.firstLog.within7Days), int(a.firstLog.users), hours(a.firstLog.medianHours)],
      ]),
      note('Within 1 day counts only users who signed up at least a day ago, and within 7 days at least a week ago. The median leaves out users who have not done it yet.')),
    card('Funnel',
      dataTable({
        id: 'funnel-steps',
        rows: f.steps,
        columns: [
          { key: 'label', label: 'Step' },
          { key: 'users', label: 'Users', num: true, bar: true, fmt: int },
          { key: 'pctOfPrev', label: 'Of the step before', num: true, fmt: pct },
          { key: 'pctOfSignups', label: 'Of sign-ups', num: true, fmt: pct },
          { key: 'medianDaysFromSignup', label: 'Median days from sign-up', num: true, fmt: (v) => dec(v, 2) },
        ],
      }),
      note('From the sheet, which counts profiles. Every step is measured from sign-up, and the steps come in any order: many people scan a bottle before a menu.'),
      subTitle('Weekly cohorts'),
      dataTable({
        id: 'funnel-cohorts',
        rows: f.cohorts,
        columns: [
          { key: 'weekStart', label: 'Week of', fmt: day },
          { key: 'signups', label: 'Sign-ups', num: true, fmt: int },
          { key: 'onboarded', label: 'Onboarded', num: true, fmt: int },
          { key: 'firstMenuScan', label: 'Menu scan', num: true, fmt: int },
          { key: 'firstBottleScan', label: 'Bottle scan', num: true, fmt: int },
          { key: 'firstLog', label: 'First log', num: true, fmt: int },
          { key: 'secondLog', label: 'Second log', num: true, fmt: int },
          { key: 'thirdLog', label: 'Third log', num: true, fmt: int },
        ],
      })),
  ];
}

// ── Engagement ──────────────────────────────────────────────────────────────

function viewEngagement(m) {
  const e = m.admin.engagement;
  const latest = e.latest;
  const sessions = e.sessions;
  const so = m.admin.social;
  const pf = m.admin.platform;
  const events = hasEvents(m);
  const activityRow = ['By activity', int(latest.activity.dau), int(latest.activity.wau), int(latest.activity.mau), share(latest.activity.dauMau)];
  const eventsRow = events
    ? ['By events', int(latest.events.dau), int(latest.events.wau), int(latest.events.mau), share(latest.events.dauMau)]
    : ['By events', { span: 4, text: EVENTS_PENDING, cls: 'pending-cell' }];
  const daily = events
    ? [{ label: 'Active by events', value: (d) => d.activeByEvents, style: 0 }, { label: 'Active by activity', value: (d) => d.activeByActivity, style: 1 }]
    : [{ label: 'Active by activity', value: (d) => d.activeByActivity, style: 1 }];

  return [
    intro(`By events, a user is active on a day the app was open. By activity, on a day they wrote something: a log, a scan, a like, a comment, a follow, a want to try or a list item.${scopeNote(m)}`),
    card(`Active users, as of ${dayYear(m.admin.scope.asOf)}`,
      staticTable(['', 'DAU', 'WAU', 'MAU', 'DAU / MAU'], [eventsRow, activityRow]),
      chartCard({
        id: 'engagement-daily', title: 'Daily active users', x: 'day', points: e.daily, series: daily, legend: true,
        notes: events ? [] : [pending('Active by events')],
      })),
    card('Sessions', events
      ? [
        tiles([
          { label: 'Event rows', value: int(sessions.eventRows) },
          { label: 'Sessions', value: int(sessions.sessionsTotal) },
          { label: 'Sessions measured', value: int(sessions.sessionsMeasured), sub: 'An app open, then the app in the background' },
          { label: 'Median session', value: duration(sessions.medianSessionSeconds) },
        ]),
        chartCard({
          id: 'engagement-sessions', title: 'Sessions per week', x: 'week', type: 'bar', points: sessions.byWeek,
          series: [{ label: 'Sessions', value: (p) => p.sessions }],
          extra: (p) => [`People: ${int(p.users)}`, `Sessions each: ${dec(p.sessionsPerUser, 2)}`],
        }),
      ]
      : pending()),
    card(`Screen views, last ${e.screenViews.windowDays} days`, events
      ? dataTable({
        id: 'screen-views',
        rows: e.screenViews.byScreen,
        emptyText: 'No screen views in the last 30 days.',
        columns: [
          { key: 'screen', label: 'Screen', wrap: true },
          { key: 'views', label: 'Views', num: true, bar: true, fmt: int },
          { key: 'users', label: 'People', num: true, fmt: int },
        ],
      })
      : pending()),
    card(`Social, ${prettyDates(so.window)}`,
      tiles([
        { label: 'Weekly actives', value: int(so.weeklyActives), sub: 'By activity' },
        { label: 'Follow someone', value: share(so.followingShare.share), sub: `${int(so.followingShare.following)} of ${int(so.followingShare.weeklyActives)} weekly actives` },
        { label: 'Follows', value: int(so.last7Days.follows.count), sub: `${dec(so.last7Days.follows.perWeeklyActive, 2)} per weekly active` },
        { label: 'Likes', value: int(so.last7Days.likes.count), sub: `${dec(so.last7Days.likes.perWeeklyActive, 2)} per weekly active` },
        { label: 'Comments', value: int(so.last7Days.comments.count), sub: `${dec(so.last7Days.comments.perWeeklyActive, 2)} per weekly active` },
        { label: 'Public profiles', value: share(so.publicProfiles.share), sub: `${int(so.publicProfiles.public)} of ${int(so.publicProfiles.users)} users` },
      ])),
    card('Platform',
      grid(2,
        el('div', { class: 'stack' },
          breakdown('Users by platform', [
            ['iOS', pf.byPlatform.ios], ['Android', pf.byPlatform.android], ['Web', pf.byPlatform.web], ['Unknown', pf.byPlatform.unknown],
          ], pf.users),
          !events && note('Until the app sends events, the platform comes from push tokens, so only people who turned on notifications have one.')),
        el('div', { class: 'stack' },
          subTitle(`App versions, last ${pf.appVersions.windowDays} days`),
          events
            ? [
              dataTable({
                id: 'app-versions',
                rows: pf.appVersions.byVersion,
                emptyText: 'No app versions in the last 30 days.',
                columns: [
                  { key: 'version', label: 'Version' },
                  { key: 'users', label: 'People', num: true, bar: true, fmt: int },
                ],
              }),
              note(`${plural(pf.appVersions.users, 'person', 'people')} used the app in the window.`),
            ]
            : pending()))),
  ];
}

// ── Retention ───────────────────────────────────────────────────────────────

function viewRetention(m) {
  const r = m.admin.retention;
  const churn = m.admin.churn;
  const events = hasEvents(m);
  const today = m.admin.scope.today;
  return [
    intro(`Each row is the people who signed up in one week. Each cell is the share of them active in a later week, where week 0 is the sign-up week. A week that has not finished yet shows n/a.${scopeNote(m)}`),
    card('By activity', retentionTable('retention-activity', r.byActivity, r.weekCount)),
    card('By events', events
      ? [retentionTable('retention-events', r.byEvents, r.weekCount), note('Weeks before the first full week of events also show n/a.')]
      : pending()),
    card('Accounts deleted', churn.total === 0
      ? empty('No accounts deleted yet.')
      : [
        tiles([
          { label: 'Deleted', value: int(churn.total) },
          { label: 'iOS', value: int(churn.byPlatform.ios) },
          { label: 'Android', value: int(churn.byPlatform.android) },
          { label: 'Platform unknown', value: int(churn.byPlatform.unknown) },
        ]),
        grid(2,
          chartCard({
            id: 'churn-deleted', title: 'Deleted per week', x: 'week', type: 'bar',
            points: fillWeeks(churn.byDeletedWeek, 'deleted', mondayOf(today)),
            series: [{ label: 'Deleted', value: (p) => p.deleted }],
          }),
          chartCard({
            id: 'churn-joined', title: 'Deleted, by the week they joined', x: 'week', type: 'bar',
            points: fillWeeks(churn.byJoinedWeek, 'deleted', null),
            series: [{ label: 'Deleted', value: (p) => p.deleted }],
          })),
      ],
      note('From the anonymous record kept when someone deletes their account: a sign-up week, a deletion week and a platform. Internal accounts are never in it.')),
  ];
}

// ── Restaurants ─────────────────────────────────────────────────────────────

function priceText(p) {
  return p && p.count > 0 ? `${money(p.median)} (${plural(p.count, 'log', 'logs')})` : NA;
}

function viewRestaurants(m) {
  const r = m.admin.restaurants;
  const lfs = r.logsFromScan;
  return [
    intro(`A venue is a Google place on a menu scan or a log. All figures are all time.${scopeNote(m)}`),
    card('Reach', tiles([
      { label: 'Menu scans with a venue', value: share(r.menuScans.share), sub: `${int(r.menuScans.withVenue)} of ${int(r.menuScans.total)}` },
      { label: 'Venues', value: int(r.uniqueVenues.total), sub: `${int(r.uniqueVenues.fromScans)} from scans, ${int(r.uniqueVenues.fromLogs)} from logs` },
      { label: 'Venues scanned more than once', value: int(r.venuesScannedMoreThanOnce) },
      { label: 'Venues scanned by two or more people', value: int(r.venuesScannedByMoreThanOneUser) },
      { label: 'Logs with a venue', value: share(r.logs.share), sub: `${int(r.logs.withVenue)} of ${int(r.logs.total)}` },
    ])),
    card('Median price paid',
      staticTable(['', 'Bottle', 'Glass'], [
        ['At a venue', priceText(r.paidPrice.atRestaurants.bottle), priceText(r.paidPrice.atRestaurants.glass)],
        ['All logs', priceText(r.paidPrice.allLogs.bottle), priceText(r.paidPrice.allLogs.glass)],
      ])),
    card('Top venues',
      dataTable({
        id: 'venues',
        rows: r.topVenues,
        search: (v) => `${v.name} ${v.neighbourhood ?? ''}`,
        searchLabel: 'Search venues',
        emptyText: 'No venues yet.',
        columns: [
          { key: 'name', label: 'Venue', wrap: true },
          { key: 'neighbourhood', label: 'Neighborhood', wrap: true },
          { key: 'scans', label: 'Scans', num: true, fmt: int },
          { key: 'users', label: 'People', num: true, fmt: int },
          { key: 'logs', label: 'Logs', num: true, fmt: int },
        ],
      }),
      note('The top 20 by menu scans, then by logs.')),
    card('Logs from a scan', lfs
      ? tiles([
        { label: 'Logs saved', value: int(lfs.loggedEvents) },
        { label: 'From a scan', value: share(lfs.shareFromScan), sub: plural(lfs.fromScan, 'log', 'logs') },
        { label: 'The top pick', value: share(lfs.shareTopPickOfScanLogs), sub: `${int(lfs.topPick)} of the logs from a scan` },
      ])
      : pending()),
  ];
}

// ── Scans ───────────────────────────────────────────────────────────────────

function countColumns(labelKey, label) {
  return [
    { key: labelKey, label },
    { key: 'count', label: 'Rows', num: true, bar: true, fmt: int },
    { key: 'pct', label: 'Share', num: true, fmt: pct },
  ];
}

function viewScans(m) {
  const q = m.sheet.scanQuality;
  const p = m.sheet.performance;
  return [
    intro(`Menu scan rows from the last ${q.windowDays} days, from the sheet.${scopeNote(m)}`),
    card('Quality',
      tiles([
        { label: 'Menu rows', value: int(q.totalRows) },
        { label: 'Resolved', value: pct(q.resolvedPct), sub: 'A catalog match or a tappable estimate' },
        { label: 'No match', value: pct(q.noMatchPct) },
      ]),
      grid(2,
        chartCard({
          id: 'scans-resolved', title: 'Resolved per day', x: 'day', points: q.resolvedPctByDay, fmt: pct, percent: true,
          series: [{ label: 'Resolved', value: (d) => d.resolvedPct }],
          extra: (d) => [`Rows: ${int(d.rows)}`],
        }),
        chartCard({
          id: 'scans-rows', title: 'Menu rows per day', x: 'day', type: 'bar', points: q.resolvedPctByDay,
          series: [{ label: 'Rows', value: (d) => d.rows }],
        }))),
    card('Outcomes', dataTable({ id: 'scans-outcomes', rows: q.byOutcome, columns: countColumns('label', 'Outcome') })),
    card('By color', dataTable({
      id: 'scans-colour',
      rows: q.byColour,
      columns: [
        { key: 'colour', label: 'Color' },
        { key: 'catalog', label: 'Catalog', num: true, fmt: int },
        { key: 'borrowed', label: 'Tappable', num: true, fmt: int },
        { key: 'thin', label: 'Thin', num: true, fmt: int },
        { key: 'incomplete', label: 'Incomplete', num: true, fmt: int },
        { key: 'noMatch', label: 'No match', num: true, fmt: int },
        { key: 'nonWine', label: 'Not wine', num: true, fmt: int },
        { key: 'other', label: 'Other', num: true, fmt: int },
        { key: 'total', label: 'Total', num: true, fmt: int },
      ],
    })),
    grid(2,
      card('Match tier', dataTable({ id: 'scans-tier', rows: q.byTier, columns: countColumns('tier', 'Tier') })),
      card('Borrow status', dataTable({ id: 'scans-borrow', rows: q.borrowStatus, columns: countColumns('status', 'Status') })),
      card('Borrow distance', dataTable({
        id: 'scans-distance',
        rows: q.borrowDistanceHisto,
        columns: [{ key: 'bucket', label: 'Distance' }, { key: 'count', label: 'Rows', num: true, bar: true, fmt: int }],
      })),
      card('Bucket size of resolved estimates', dataTable({
        id: 'scans-bucket',
        rows: q.bucketNHisto,
        columns: [{ key: 'band', label: 'Wines in the bucket' }, { key: 'count', label: 'Rows', num: true, bar: true, fmt: int }],
      }))),
    card('Recent scans', dataTable({
      id: 'scans-recent',
      rows: q.recentScans,
      columns: [
        { key: 'scanId8', label: 'Scan' },
        { key: 'date', label: 'Date', fmt: day },
        { key: 'displayName', label: 'Person', wrap: true },
        { key: 'rows', label: 'Rows', num: true, fmt: int },
        { key: 'resolvedPct', label: 'Resolved', num: true, fmt: pct },
      ],
    })),
    card('Performance',
      tiles([
        { label: 'Rows per scan, median', value: int(p.rowsPerScan.median), sub: `Least ${int(p.rowsPerScan.min)}, 95th percentile ${int(p.rowsPerScan.p95)}, most ${int(p.rowsPerScan.max)}` },
        { label: 'Pages per scan', value: dec(p.avgPagesPerScan, 2), sub: 'Average, last 30 days' },
        { label: 'Bottle scan time', value: ms(p.bottleLatency), sub: p.bottleLatencyNote },
      ]),
      grid(2,
        chartCard({
          id: 'perf-wall', title: 'Menu scan time per day', x: 'day', points: p.menuByDay, fmt: ms,
          series: [{ label: 'Median', value: (d) => d.p50WallMs }, { label: '95th percentile', value: (d) => d.p95WallMs }],
          extra: (d) => [`Scans: ${int(d.scans)}`],
        }),
        chartCard({
          id: 'perf-index', title: 'Catalog lookup time per day', x: 'day', points: p.menuByDay, fmt: ms,
          series: [{ label: 'Median', value: (d) => d.p50CatalogIdxMs }, { label: '95th percentile', value: (d) => d.p95CatalogIdxMs }],
        }))),
  ];
}

// ── Catalog ─────────────────────────────────────────────────────────────────

function viewCatalog(m) {
  const h = m.sheet.catalogHealth;
  const c = h.counts;
  const gaps = m.sheet.catalogGaps;
  const yesNo = (v) => (v ? 'Yes' : 'No');
  return [
    intro('The catalog counts approved curator wines only. A gap is a group of menu rows from the last 30 days that matched nothing, by grape, region, color and type.'),
    card('Catalog', tiles([
      { label: 'Catalog wines', value: int(c.curatorWines), sub: 'Approved curator wines' },
      { label: 'Scanner mints', value: int(c.scannerMints) },
      { label: 'Mints pending review', value: int(c.mintsPendingReview), sub: c.oldestPendingMint ? `Oldest from ${dayYear(c.oldestPendingMint)}` : 'None waiting' },
      { label: 'Mints kept for their user only', value: int(c.reviewUserOnly) },
      { label: 'Vintage unknown', value: int(c.vintageUnknown) },
      { label: 'No editorial', value: int(c.noEditorial) },
      { label: 'No current taste profile', value: int(c.noCurrentTaste) },
      { label: 'Grapes', value: int(c.distinctGrapes) },
      { label: 'Regions', value: int(c.distinctRegions) },
      { label: 'Buckets', value: int(c.bucketCount) },
    ])),
    grid(2,
      card('Bucket sizes', dataTable({
        id: 'catalog-bands',
        rows: h.bucketBands,
        columns: [{ key: 'band', label: 'Wines in the bucket' }, { key: 'count', label: 'Buckets', num: true, bar: true, fmt: int }],
      })),
      card('Aliases and hygiene', kv([
        ['Grape aliases', int(h.aliases.grape)],
        ['Region aliases', int(h.aliases.region)],
        ['Rows matched only through an alias, last 30 days', int(h.aliases.rowsMatchedOnlyViaAlias30d)],
        ['LWIN codes on more than one label', `${int(h.hygiene.lwinCrossLabelCodes)} codes, ${int(h.hygiene.lwinCrossLabelWines)} wines`],
        ['Names with a bottle size in them', int(h.hygiene.bottleSizeNames)],
        ['One taste vector over 3 or more vintages', `${int(h.hygiene.repeatedVectorGroups)} groups, ${int(h.hygiene.repeatedVectorWines)} wines`],
        ['Producers spelled more than one way', `${int(h.hygiene.producerSpellingClusters)} producers, ${int(h.hygiene.producerSpellingWines)} wines`],
      ]))),
    card('Catalog gaps', dataTable({
      id: 'catalog-gaps',
      rows: gaps.groups,
      search: (g) => [g.grape, g.region, g.colour, g.type, g.example, g.verdict].join(' '),
      searchLabel: 'Search gaps',
      emptyText: 'No gaps in the last 30 days.',
      columns: [
        { key: 'grape', label: 'Grape', wrap: true },
        { key: 'region', label: 'Region', wrap: true },
        { key: 'colour', label: 'Color' },
        { key: 'type', label: 'Type' },
        { key: 'rows', label: 'Rows', num: true, fmt: int },
        { key: 'scans', label: 'Scans', num: true, fmt: int },
        { key: 'users', label: 'People', num: true, fmt: int },
        { key: 'example', label: 'Example', wrap: true },
        { key: 'verdict', label: 'In the catalog' },
      ],
    })),
    grid(2,
      card('Missing grapes', dataTable({
        id: 'gap-grapes',
        rows: gaps.topGrapes,
        columns: [
          { key: 'grape', label: 'Grape', wrap: true },
          { key: 'rows', label: 'Rows', num: true, bar: true, fmt: int },
          { key: 'scans', label: 'Scans', num: true, fmt: int },
          { key: 'inCatalog', label: 'In the catalog', fmt: yesNo, value: (r) => (r.inCatalog ? 1 : 0) },
        ],
      })),
      card('Missing regions', dataTable({
        id: 'gap-regions',
        rows: gaps.topRegions,
        columns: [
          { key: 'region', label: 'Region', wrap: true },
          { key: 'rows', label: 'Rows', num: true, bar: true, fmt: int },
          { key: 'scans', label: 'Scans', num: true, fmt: int },
          { key: 'inCatalog', label: 'In the catalog', fmt: yesNo, value: (r) => (r.inCatalog ? 1 : 0) },
        ],
      }))),
  ];
}

// ── Logging and taste ───────────────────────────────────────────────────────

function countTable(id, rows, key, label, valueKey = 'count', valueLabel = 'Logs') {
  return dataTable({
    id,
    rows,
    columns: [
      { key, label, wrap: true },
      { key: valueKey, label: valueLabel, num: true, bar: true, fmt: int },
    ],
  });
}

function dimensionTable(dims) {
  if (!dims.length) return empty('No taste profiles yet.');
  const ranges = dims[0].buckets.map((b) => b.range);
  const max = Math.max(1, ...dims.flatMap((d) => d.buckets.map((b) => b.count)));
  return el('div', { class: 'table-wrap' }, el('table', { class: 'heat' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col', class: 'cohort' }, 'Dimension'), ranges.map((r) => el('th', { scope: 'col', class: 'num' }, r)))),
    el('tbody', {}, dims.map((d) => el('tr', {},
      el('th', { scope: 'row', class: 'cohort' }, String(d.dimension).replace(/_/g, ' ')),
      d.buckets.map((b) => shadeCell(el('td', {}, int(b.count)), b.count / max)))))));
}

function viewLogging(m) {
  const t = m.sheet.loggingTaste;
  return [
    intro(`Every log, from the sheet.${scopeNote(m)}`),
    grid(3,
      card('Ratings', countTable('logging-rating', t.byRating, 'rating', 'Rating')),
      card('Colors', countTable('logging-colour', t.byColour, 'colour', 'Color')),
      card('Occasions', countTable('logging-occasion', t.byOccasion, 'occasion', 'Occasion'))),
    card('Price paid', dataTable({
      id: 'logging-price',
      rows: t.priceByUnit,
      emptyText: 'No prices yet.',
      columns: [
        { key: 'unit', label: 'Per' },
        { key: 'count', label: 'Logs', num: true, fmt: int },
        { key: 'min', label: 'Least', num: true, fmt: money },
        { key: 'p25', label: '25th percentile', num: true, fmt: money },
        { key: 'median', label: 'Median', num: true, fmt: money },
        { key: 'p75', label: '75th percentile', num: true, fmt: money },
        { key: 'max', label: 'Most', num: true, fmt: money },
      ],
    })),
    grid(2,
      card('Descriptors matched', countTable('logging-descriptors', t.topDescriptorsMatched, 'text', 'Descriptor')),
      card('Descriptor tags', countTable('logging-tags', t.topDescriptorTags, 'tag', 'Tag')),
      card('Food pairings', countTable('logging-pairings', t.topFoodPairings, 'pairing', 'Pairing')),
      card('Food pairings, typed', countTable('logging-pairing-text', t.foodPairingFreeText, 'text', 'What they typed'))),
    grid(2,
      card('Logs per person',
        tiles([
          { label: 'People with logs', value: int(t.logsPerUser.usersWithLogs) },
          { label: 'Median logs each', value: dec(t.logsPerUser.medianPerLogger, 1) },
        ]),
        countTable('logging-per-user', t.logsPerUser.bands, 'band', 'Logs', 'count', 'People')),
      card('Where logs come from', kv([
        ['From a scan', int(t.logSource.fromScan)],
        ['From the catalog', int(t.logSource.fromCatalog)],
        ['Other', int(t.logSource.fromOther)],
        ['Share from a scan', pct(t.logSource.pctFromScan)],
      ]))),
    grid(2,
      card('Colors picked at onboarding', countTable('logging-coverage', t.tasteCoverage, 'colour', 'Color', 'usersPicked', 'People')),
      card('Taste dimensions',
        dimensionTable(t.dimensionDistributions),
        note('Every color of every current taste profile, on the 1 to 4 scale.'))),
  ];
}

// ── Testers ─────────────────────────────────────────────────────────────────

function viewTesters(m) {
  const rows = m.sheet.testers;
  return [
    intro(`The ${int(rows.length)} people active most recently, from the sheet. Last active counts logs and scans.${scopeNote(m)}`),
    card(null, dataTable({
      id: 'testers',
      rows,
      search: (r) => `${r.displayName} ${r.profileColours}`,
      searchLabel: 'Search testers',
      emptyText: 'No testers yet.',
      columns: [
        { key: 'displayName', label: 'Name', wrap: true },
        { key: 'signedUp', label: 'Signed up', fmt: day },
        { key: 'onboarded', label: 'Onboarded', fmt: (v) => (v ? 'Yes' : 'No'), value: (r) => (r.onboarded ? 1 : 0) },
        { key: 'menuScans', label: 'Menu scans', num: true, fmt: int },
        { key: 'bottleScans', label: 'Bottle scans', num: true, fmt: int },
        { key: 'logs', label: 'Logs', num: true, fmt: int },
        { key: 'wantToTry', label: 'Want to try', num: true, fmt: int },
        { key: 'lastActive', label: 'Last active', fmt: day },
        { key: 'daysSinceActive', label: 'Days since', num: true, fmt: int },
        { key: 'profileColours', label: 'Colors picked', fmt: (v) => v || NA, cls: 'nowrap' },
      ],
    })),
  ];
}

// ── Feedback ────────────────────────────────────────────────────────────────

const FEEDBACK = [
  { title: 'TestFlight feedback', path: ['App Store Connect', 'TestFlight', 'Feedback'], href: 'https://appstoreconnect.apple.com/apps/6791446035' },
  { title: 'App Store ratings and reviews', path: ['App Store Connect', 'Ratings and Reviews'], href: 'https://appstoreconnect.apple.com/apps/6791446035' },
  { title: 'Google Play ratings and reviews', path: ['Google Play Console', 'Ratings and reviews'], href: 'https://play.google.com/console' },
  { title: 'Email', path: ['The hello@glug-wine.com inbox'], href: 'https://mail.google.com' },
];

function viewFeedback() {
  return [
    intro('Where feedback arrives. Each link opens the console, and the path says where to go from there.'),
    card(null, el('ul', { class: 'links' }, FEEDBACK.map((f) => el('li', {},
      el('h2', { class: 'link-title' }, f.title),
      el('p', { class: 'path' }, f.path.join(' › ')),
      el('a', { href: f.href, target: '_blank', rel: 'noopener noreferrer' }, f.href.replace(/^https:\/\//, '')))))),
  ];
}

// ── Start ───────────────────────────────────────────────────────────────────

async function boot() {
  root = document.getElementById('app');
  if (!window.Chart || (!FIXTURE && !window.supabase?.createClient)) {
    root.append(el('p', { class: 'boot-error' }, 'A script did not load. Reload the page.'));
    return;
  }
  C = readColors();
  const Chart = window.Chart;
  Chart.defaults.font.family = "'Ysabeau Office', system-ui, -apple-system, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = C.sage;
  try {
    await document.fonts.load("400 12px 'Ysabeau Office'"); // canvas text needs the face loaded first
  } catch {
    // the charts fall back to the system font
  }

  window.addEventListener('hashchange', () => {
    if (!shell.main) return;
    route();
    window.scrollTo(0, 0);
  });

  if (FIXTURE) {
    document.title = 'glug admin (fixture)';
    startDashboard();
    return;
  }

  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { storageKey: 'glug-admin', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  sb.auth.onAuthStateChange((event) => {
    // signed out elsewhere, or the refresh token was revoked
    if (event === 'SIGNED_OUT' && state.me) {
      state.me = null;
      resetData();
      renderSignIn('You are signed out.');
    }
  });
  const { data } = await sb.auth.getSession();
  if (data?.session) startDashboard();
  else renderSignIn();
}

boot();
