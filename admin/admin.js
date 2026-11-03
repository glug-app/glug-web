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
// venue and wine names, typed food pairings, event props) reaches the page through el()
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
const NO_BUILD_EVENTS = 'No events from these builds yet.';
const BUILDS_STORE = 'glug-admin-builds'; // localStorage: the Builds choice, kept per browser
const TZ = 'America/New_York';

// The views, in nav order. `data` says which answer a view is drawn from.
const VIEWS = [
  { id: 'reports', label: 'Reports', data: 'reports', render: viewReports },
  { id: 'overview', label: 'Overview', data: 'metrics', render: viewOverview },
  { id: 'investors', label: 'Investors', data: 'metrics', render: viewInvestors },
  { id: 'growth', label: 'Growth', data: 'metrics', render: viewGrowth },
  { id: 'engagement', label: 'Engagement', data: 'metrics', render: viewEngagement },
  { id: 'events', label: 'Events', data: 'events', render: viewEvents },
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
  includeTest: false, // the "Hide test accounts" switch is on by default
  builds: savedBuilds(), // "release" (store builds), "all" or picked build keys
  metrics: null,
  metricsBuilds: null, // the builds choice the loaded metrics answer
  metricsBusy: false,
  metricsError: null,
  reports: null,
  reportsBusy: false,
  reportsError: null,
  reportsNotice: null,
  reportsFilter: 'open',
  events: eventsChoices(), // the Events view's mode and filters, kept while signed in
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
  console.debug('[fixture]', JSON.stringify(body)); // what the function would have been sent
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
      return fixtureMetrics(body);
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
    case 'events':
      return fixtureEvents(body);
    default:
      throw new ApiError(400, 'unknown_action');
  }
}

// The events action over fixture.events. `rows` are in the table at load; each
// live poll (a call with after_id) lets the next batch of `later` arrive, one of
// them holding a row whose id is lower than ids already shown (the late commit
// that section 6.2 polls with an overlap for). Every time moves by whole seconds
// so the newest row arrived at load. A query the function would refuse, and a
// cursor this fixture did not hand out, are a 400 like the function's.
let fixtureEventRows = null;
let fixtureLater = [];
let fixtureShift = 0;
const fixtureCursors = new Set();

function fixtureEventsInit() {
  if (fixtureEventRows) return;
  fixtureShift = Math.round((Date.now() - Math.max(...fixture.events.rows.map((r) => eventMs(r.received_at)))) / 1000) * 1000;
  const move = (r) => ({ ...r, occurred_at: shiftStamp(r.occurred_at, fixtureShift), received_at: shiftStamp(r.received_at, fixtureShift) });
  fixtureEventRows = fixture.events.rows.map(move);
  fixtureLater = fixture.events.later.map((batch) => batch.map(move));
}

function fixtureEvents(b) {
  fixtureEventsInit();
  const list = fixtureBuilds(b.include_test === true);
  if (!fixtureEventsQueryOk(b) || (list && !fixtureBuildsOk(b.builds))) throw new ApiError(400, 'invalid_events_query');
  if (b.mode === 'live' && b.after_id !== undefined && fixtureLater.length > 0) fixtureEventRows.push(...fixtureLater.shift());

  const micros = (s) => eventMs(s) * 1000 + Number((/\.\d{3}(\d*)/.exec(s)?.[1] ?? '').padEnd(3, '0'));
  const choice = list ? b.builds ?? 'release' : 'all';
  let rows = fixtureEventRows.filter((r) => (b.include_test === true || !r.user.test) &&
    (!b.names || b.names.includes(r.name)) && (!b.user_id || r.user.id === b.user_id.toLowerCase()) &&
    fixtureInBuilds(r, choice));
  let next = null;
  if (b.mode === 'live') {
    rows = rows.filter((r) => b.after_id === undefined || r.id > b.after_id)
      .sort((x, y) => y.id - x.id)
      .slice(0, b.after_id === undefined ? 100 : 200);
  } else {
    const from = Date.parse(b.from) * 1000;
    const to = Date.parse(b.to) * 1000;
    const c = b.before && { at: micros(b.before.occurred_at), id: b.before.id };
    rows = rows.filter((r) => {
      const at = micros(r.occurred_at);
      return at >= from && at < to && (!c || at < c.at || (at === c.at && r.id < c.id));
    }).sort((x, y) => micros(y.occurred_at) - micros(x.occurred_at) || y.id - x.id);
    if (rows.length > 200) {
      rows = rows.slice(0, 200);
      next = { occurred_at: rows[199].occurred_at, id: rows[199].id };
      fixtureCursors.add(`${next.occurred_at}|${next.id}`);
    }
  }
  const since = (Date.now() - 30 * DAY_MS) * 1000;
  const recent = fixtureEventRows.filter((r) => micros(r.occurred_at) >= since);
  const people = new Map();
  for (const r of recent) if (b.include_test === true || !r.user.test) people.set(r.user.id, r.user);
  const out = {
    rows,
    next,
    latest_id: rows.length > 0 ? Math.max(...rows.map((r) => r.id)) : null,
    names: [...new Set(recent.map((r) => r.name))].sort(),
    people: [...people.values()].sort((x, y) => (x.display_name === null) - (y.display_name === null) ||
      (x.display_name ?? '').localeCompare(y.display_name ?? '', 'en', { sensitivity: 'base' }) || (x.id < y.id ? -1 : 1)),
  };
  if (list) out.builds = fixtureBuildsOut(list);
  return structuredClone(out);
}

// The builds scope. fixture.json's `builds` (and `buildsWithTest`, for include_test) is the
// list a server that knows builds sends; without one, the fixture is a server from before
// builds: it ignores the key and sends no list. A row's build is the listed one with its
// platform, version, build, channel and commit.

function fixtureBuilds(includeTest) {
  const list = includeTest ? fixture.buildsWithTest ?? fixture.builds : fixture.builds;
  return Array.isArray(list) ? list : null;
}

/** What a server would refuse: anything but "release", "all" or a list of one or more keys. */
function fixtureBuildsOk(v) {
  return v === undefined || v === 'release' || v === 'all' ||
    (Array.isArray(v) && v.length > 0 && v.every((k) => typeof k === 'string' && k !== ''));
}

function fixtureInBuilds(r, choice) {
  if (choice === 'all') return true;
  if (choice === 'release') return r.channel === 'release';
  const b = (fixture.buildsWithTest ?? fixture.builds).find((x) =>
    ['platform', 'app_version', 'build', 'channel', 'commit'].every((k) => x?.[k] === r[k]));
  return b !== undefined && choice.includes(b.key);
}

/** The list with its times moved like the event rows'. An entry that is not a build passes as it is. */
function fixtureBuildsOut(list) {
  return list.map((x) => (x !== null && typeof x === 'object'
    ? { ...x, first_seen: shiftStamp(x.first_seen, fixtureShift), last_seen: shiftStamp(x.last_seen, fixtureShift) }
    : x));
}

/** metrics, with the builds list when the fixture has one. The event figures are emptied when
 *  no counted row (a v2 row of a user in scope) is in the choice: the figures stand for every
 *  build otherwise, a fixture's shortcut. */
function fixtureMetrics(b) {
  const inc = b.include_test === true;
  const m = structuredClone(inc ? fixture.metricsWithTest ?? fixture.metrics : fixture.metrics);
  const list = fixtureBuilds(inc);
  if (list && !fixtureBuildsOk(b.builds)) throw new ApiError(400, 'invalid_builds');
  fixtureEventsInit();
  const choice = list ? b.builds ?? 'release' : 'all';
  if (!fixtureEventRows.some((r) => r.schema_version !== null && (inc || !r.user.test) && fixtureInBuilds(r, choice))) {
    const a = m.admin;
    a.scope.preferredBasis = 'activity';
    a.engagement.latest.events = { dau: 0, wau: 0, mau: 0, dauMau: null };
    for (const d of a.engagement.daily) d.activeByEvents = 0;
    a.engagement.sessions = { eventRows: 0, sessionsTotal: 0, sessionsMeasured: 0, medianSessionSeconds: null, byWeek: [] };
    a.engagement.screenViews.byScreen = [];
    a.platform.appVersions = { ...a.platform.appVersions, users: 0, byVersion: [] };
    for (const c of a.retention.byEvents) c.weeks = c.weeks.map(() => null);
    a.restaurants.logsFromScan = null;
  }
  if (list) m.builds = fixtureBuildsOut(list);
  return m;
}

/** What events.ts parseEventsQuery refuses, near enough to catch a bad request here. */
function fixtureEventsQueryOk(b) {
  const NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const time = (v, digits) => typeof v === 'string' && Number.isFinite(eventMs(v)) &&
    new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,${digits}})?)?(Z|[+-]\\d{2}:\\d{2})$`).test(v);
  const count = (v) => Number.isSafeInteger(v) && v >= 0;
  if (b.names !== undefined && !(Array.isArray(b.names) && b.names.length >= 1 && b.names.length <= EVENTS_MAX_NAMES &&
    b.names.every((n) => typeof n === 'string' && n.length <= 64 && NAME.test(n)))) return false;
  if (b.user_id !== undefined && !(typeof b.user_id === 'string' && UUID.test(b.user_id))) return false;
  if (b.include_test !== undefined && typeof b.include_test !== 'boolean') return false;
  if (b.mode === 'live') {
    return b.from === undefined && b.to === undefined && b.before === undefined && (b.after_id === undefined || count(b.after_id));
  }
  if (b.mode !== 'window' || b.after_id !== undefined || !time(b.from, 3) || !time(b.to, 3)) return false;
  const span = Date.parse(b.to) - Date.parse(b.from);
  if (!(span > 0) || span > EVENTS_MAX_DAYS * DAY_MS) return false;
  return b.before === undefined || (typeof b.before === 'object' && b.before !== null && Object.keys(b.before).length === 2 &&
    time(b.before.occurred_at, 6) && count(b.before.id) && fixtureCursors.has(`${b.before.occurred_at}|${b.before.id}`));
}

/** A fixture timestamp ("...T21:14:09.482123+00:00") moved by whole seconds, its fraction and zone kept as written. */
function shiftStamp(s, ms) {
  const head = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.exec(s)?.[0];
  return head ? new Date(Date.parse(`${head}Z`) + ms).toISOString().slice(0, 19) + s.slice(19) : s;
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
    metrics: null, metricsBuilds: null, metricsBusy: false, metricsError: null,
    reports: null, reportsBusy: false, reportsError: null, reportsNotice: null,
    events: eventsChoices(),
  });
  Object.assign(pickers, { names: [], people: [], namesKey: '', peopleKey: '', known: new Map() });
  Object.assign(buildsData, { list: null, known: new Map(), drawn: '' });
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
    const builds = buildsParam();
    const answer = await call({ action: 'metrics', include_test: state.includeTest, builds });
    if (seq !== metricsSeq) return;
    state.metrics = answer;
    state.metricsBuilds = builds;
    syncBuilds(answer);
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

function toggleTest() {
  state.includeTest = !state.includeTest;
  loadMetrics();
  restartEvents(); // only when the Events view is open
}

// ── The signed-in page: header, nav, main ───────────────────────────────────

function teardown() {
  destroyCharts();
  stopEvents();
  shell = {};
  clear(root);
}

function buildShell() {
  teardown();
  shell.generated = el('span', { class: 'generated' });
  shell.switch = el('button', { class: 'switch', type: 'button', role: 'switch', onclick: toggleTest },
    el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-knob' })),
    el('span', {}, 'Hide test accounts'),
  );
  shell.refresh = el('button', { class: 'btn', type: 'button', onclick: refresh }, 'Refresh');
  shell.buildsText = el('span', {});
  shell.builds = el('button', {
    class: 'btn builds-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'builds-panel',
    onclick: () => {
      const open = shell.buildsPanel.hidden;
      shell.buildsPanel.hidden = !open;
      shell.builds.setAttribute('aria-expanded', String(open));
    },
  }, shell.buildsText, el('span', { class: 'picker-mark', 'aria-hidden': 'true' }, '▾'));
  shell.buildsQuick = seg('Builds', BUILDS_QUICK, state.builds, setBuilds);
  shell.buildsList = el('div', { class: 'builds-groups' });
  shell.buildsPanel = el('div', { class: 'builds-panel', id: 'builds-panel', hidden: true },
    shell.buildsQuick,
    el('p', { class: 'hint' }, 'Applies to figures from app events: opens, sessions, screens, log sources and the Events view. Logs, scans and sign-ups count every build.'),
    shell.buildsList);
  const name = (typeof state.me?.display_name === 'string' && state.me.display_name.trim()) || 'Admin';

  const header = el('header', { class: 'top' },
    el('div', { class: 'top-brand' },
      el('span', { class: 'brand' }, 'glug admin'),
      FIXTURE && el('span', { class: 'chip' }, 'Fixture')),
    el('div', { class: 'top-data' }, shell.generated,
      el('div', { class: 'top-controls' }, el('div', { class: 'top-filters' }, shell.switch, shell.builds), shell.refresh)),
    el('div', { class: 'top-user' },
      el('span', { class: 'who' }, name),
      el('button', { class: 'btn', type: 'button', onclick: () => endSession('') }, 'Sign out')),
    shell.buildsPanel,
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
  buildsData.drawn = '';
  drawBuildsPicker();
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
  shell.switch.setAttribute('aria-checked', String(!state.includeTest));
  updateBuildsPicker();
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
  stopEvents();
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
  if (view.id === 'events') startEvents();
  updateChrome();
}

// ── Builds ──────────────────────────────────────────────────────────────────
//
// Which app builds the event figures and the Events view count: every metrics
// and events call carries `builds`, "release" (the store builds, the server's
// default), "all", or a list of build keys picked from the `builds` list each
// answer carries. Logs, scans and sign-ups count every build whatever it says.
// A server from before the scope ignores the key and sends no list: the panel
// then offers the two quick choices only, and no figure says the chosen builds
// have no events, since nothing was filtered.

const BUILDS_QUICK = [['release', 'Store builds'], ['all', 'All builds']];
const PLATFORM_ORDER = ['ios', 'android', 'web'];
const buildsData = { list: null, known: new Map(), drawn: '' }; // the last answer's list; every build seen; what the panel shows

/** The choice this browser kept, or Store builds. */
function savedBuilds() {
  try {
    const v = JSON.parse(localStorage.getItem(BUILDS_STORE));
    if (v === 'release' || v === 'all') return v;
    const keys = Array.isArray(v) ? [...new Set(v.filter((k) => typeof k === 'string' && k !== ''))].sort() : [];
    if (keys.length > 0) return keys;
  } catch {
    // no storage in this browser, or something in it that is not a choice
  }
  return 'release';
}

function buildsParam() {
  return Array.isArray(state.builds) ? [...state.builds] : state.builds;
}

/** A new choice: kept in this browser, then the figures and the Events view load again. */
function setBuilds(choice) {
  if (JSON.stringify(choice) === JSON.stringify(state.builds)) return;
  state.builds = choice;
  try {
    localStorage.setItem(BUILDS_STORE, JSON.stringify(choice));
  } catch {
    // the choice then lasts until the page closes
  }
  drawBuildsPicker(); // an unticked build the list no longer has leaves the panel
  loadMetrics();
  restartEvents(); // only when the Events view is open
}

/** Ticking rows makes a custom choice; ticking none goes back to Store builds. */
function pickBuild(key, on) {
  const picked = Array.isArray(state.builds) ? state.builds : [];
  const next = on ? [...new Set([...picked, key])].sort() : picked.filter((k) => k !== key);
  setBuilds(next.length > 0 ? next : 'release');
}

/** "Show all builds", from a figure or the Events view. The button goes when the view
 *  redraws, so the focus moves to the header control, which now says All builds. */
function showAllBuilds() {
  setBuilds('all');
  shell.builds?.focus({ preventScroll: true });
}

/** Whether the loaded figures were filtered by build: the server knows builds (its answer
 *  carries the list) and the choice was not "all". */
function byBuilds(m) {
  return Array.isArray(m.builds) && state.metricsBuilds !== 'all';
}

/** The list comes with every metrics and events answer, and is null from a server that does not know builds. */
function syncBuilds(answer) {
  const list = Array.isArray(answer?.builds)
    ? answer.builds.filter((b, i, all) => typeof b?.key === 'string' && b.key !== '' && all.findIndex((x) => x?.key === b.key) === i)
    : null;
  buildsData.list = list;
  for (const b of list ?? []) buildsData.known.set(b.key, b);
  drawBuildsPicker();
}

const buildText = (v) => (typeof v === 'string' || isNum(v) ? String(v).trim() : '');

/** "iOS 1.0.1 (33)": the platform, the version and the build number. */
function buildName(b) {
  const build = buildText(b.build);
  const platform = Object.hasOwn(PLATFORMS, b.platform) ? PLATFORMS[b.platform] : buildText(b.platform);
  const name = [platform, buildText(b.app_version), build && `(${build})`].filter(Boolean).join(' ');
  return name || b.key;
}

/** A last-seen time (or date) as its New York day, "Nov 3", with the year when it is not this one. */
function seenDay(v) {
  const t = typeof v === 'string' && ISO_DAY.test(v) ? Date.parse(`${v}T12:00:00Z`) : eventMs(v);
  if (!Number.isFinite(t)) return NA;
  const p = nyClock(t);
  const date = `${MONTHS[Number(p.month) - 1]} ${Number(p.day)}`;
  return p.year === nyClock(Date.now()).year ? date : `${date}, ${p.year}`;
}

function buildOrder(x, y) {
  const rank = (b) => (PLATFORM_ORDER.includes(b.platform) ? PLATFORM_ORDER.indexOf(b.platform) : PLATFORM_ORDER.length);
  const desc = (a, b) => buildText(b).localeCompare(buildText(a), 'en', { numeric: true });
  return rank(x) - rank(y) || desc(x.app_version, y.app_version) || desc(x.build, y.build) ||
    buildText(x.commit).localeCompare(buildText(y.commit)) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
}

/** The checklist: the server's builds, Store then Dev, and under Not in the list any picked
 *  build the list does not have now. Redrawn only when what it shows changes, so the live
 *  feed's answers every 5 s do not rebuild it under the pointer. */
function drawBuildsPicker() {
  const holder = shell.buildsList;
  if (!holder) return;
  const list = buildsData.list ?? [];
  const listed = new Set(list.map((b) => b.key));
  const missing = (Array.isArray(state.builds) ? state.builds : []).filter((k) => !listed.has(k))
    .map((k) => buildsData.known.get(k) ?? { key: k });
  const row = (b, gone) => ({
    key: b.key,
    name: buildName(b),
    commit: b.channel !== 'release' ? buildText(b.commit).slice(0, 7) : '',
    newest: !gone && b.is_newest_release === true,
    meta: gone ? '' : `${plural(b.users, 'person', 'people')}, last seen ${seenDay(b.last_seen)}`,
  });
  const groups = [
    ['Store', list.filter((b) => b.channel === 'release').sort(buildOrder).map((b) => row(b, false))],
    ['Dev', list.filter((b) => b.channel !== 'release').sort(buildOrder).map((b) => row(b, false))],
    ['Not in the list', missing.map((b) => row(b, true)).sort((x, y) => x.name.localeCompare(y.name, 'en', { numeric: true }))],
  ].filter(([, rows]) => rows.length > 0);
  const drawn = JSON.stringify(groups);
  if (drawn === buildsData.drawn) return;
  buildsData.drawn = drawn;

  const focused = holder.contains(document.activeElement) ? document.activeElement.value : null;
  clear(holder);
  for (const [title, rows] of groups) {
    holder.append(el('fieldset', { class: 'builds-group' }, el('legend', {}, title), rows.map((b) => {
      const box = el('input', { type: 'checkbox', value: b.key });
      box.addEventListener('change', () => pickBuild(b.key, box.checked));
      return el('label', { class: 'pick build-pick' }, box,
        el('span', { class: 'build-text' },
          el('span', { class: 'build-name' },
            b.name,
            b.commit ? [' ', el('span', { class: 'build-commit' }, b.commit)] : null,
            b.newest && [' ', el('span', { class: 'chip' }, 'newest')]),
          b.meta ? [' ', el('span', { class: 'build-meta' }, b.meta)] : null));
    })));
  }
  updateBuildsPicker();
  if (focused !== null) [...holder.querySelectorAll('input')].find((box) => box.value === focused)?.focus();
}

/** The header label, the quick choice that is on, and the ticks. */
function updateBuildsPicker() {
  if (!shell.builds) return;
  const b = state.builds;
  shell.buildsText.textContent = Array.isArray(b) ? plural(b.length, 'build', 'builds') : b === 'all' ? 'All builds' : 'Store builds';
  BUILDS_QUICK.forEach(([value], i) => shell.buildsQuick.children[i].setAttribute('aria-pressed', String(value === b)));
  const picked = new Set(Array.isArray(b) ? b : []);
  for (const box of shell.buildsList.querySelectorAll('input')) box.checked = picked.has(box.value);
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

/** What an event figure or the Events view says when the chosen builds have no events, and the way back to every build. */
function buildsEmptyLine(text = NO_BUILD_EVENTS) {
  return el('span', { class: 'builds-empty' },
    el('span', {}, text),
    el('button', { class: 'btn', type: 'button', onclick: showAllBuilds }, 'Show all builds'));
}

/** An event figure with nothing to show: pending() while no build has sent an event,
 *  else the line that says the chosen builds have none. */
function noEvents(m, label) {
  if (!byBuilds(m)) return pending(label);
  return el('div', { class: 'pending' }, label && el('span', { class: 'pending-label' }, label), buildsEmptyLine());
}

/** Under a build choice only the chosen builds' rows count, while preferredBasis
 *  can still say "events" because of the other builds. */
function hasEvents(m) {
  return m.admin.engagement.sessions.eventRows > 0 || (!byBuilds(m) && m.admin.scope.preferredBasis === 'events');
}

function scopeNote(m) {
  const s = m.admin.scope;
  return s.includeTest
    ? ' Test accounts are counted.'
    : ` ${plural(s.testAccounts, 'test account is', 'test accounts are')} left out.`;
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

/** A tile's `better` ("up" or "down", ADMIN_DASHBOARD.md 6.1a) says which way its
 *  7-day change is good news. Zero, no value or no `better` stays muted. */
function changeTone(t) {
  if (!isNum(t.change7d) || t.change7d === 0 || (t.better !== 'up' && t.better !== 'down')) return null;
  return (t.change7d > 0) === (t.better === 'up') ? 'is-better' : 'is-worse';
}

function overviewTile(t) {
  const isPct = /Pct30d$/.test(t.key);
  // only the signed number takes the colour; the sign stays, so colour is never the only signal
  const change = isNum(t.change7d) && el('span', { class: cls('change', changeTone(t)) }, signed(t.change7d, isPct ? 1 : 0));
  let sub;
  if (!change) sub = t.key === 'active30d' ? null : `7-day change: ${NA}`;
  else if (isPct) sub = [change, ' points against the 7 days before'];
  else if (NEW_IN_7_DAYS.has(t.key)) sub = [change, ' in the last 7 days'];
  else if (VS_PRIOR_7_DAYS.has(t.key)) sub = [change, ' against the 7 days before'];
  else sub = ['7-day change: ', change];
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
    : ['By events', { span: 4, text: byBuilds(m) ? buildsEmptyLine() : EVENTS_PENDING, cls: 'pending-cell' }];
  const daily = events
    ? [{ label: 'Active by events', value: (d) => d.activeByEvents, style: 0 }, { label: 'Active by activity', value: (d) => d.activeByActivity, style: 1 }]
    : [{ label: 'Active by activity', value: (d) => d.activeByActivity, style: 1 }];

  return [
    intro(`By events, a user is active on a day the app was open. By activity, on a day they wrote something: a log, a scan, a like, a comment, a follow, a want to try or a list item.${scopeNote(m)}`),
    card(`Active users, as of ${dayYear(m.admin.scope.asOf)}`,
      staticTable(['', 'DAU', 'WAU', 'MAU', 'DAU / MAU'], [eventsRow, activityRow]),
      chartCard({
        id: 'engagement-daily', title: 'Daily active users', x: 'day', points: e.daily, series: daily, legend: true,
        notes: events ? [] : [noEvents(m, 'Active by events')],
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
      : noEvents(m)),
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
      : noEvents(m)),
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
          !events && !byBuilds(m) && note('Until the app sends events, the platform comes from push tokens, so only people who turned on notifications have one.')),
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
            : noEvents(m)))),
  ];
}

// ── Events ──────────────────────────────────────────────────────────────────
//
// The app's raw events (ADMIN_DASHBOARD.md section 6.2). Live asks every 5 s,
// while this view is open and the tab is visible, for the ids above the highest
// one shown less 100: an id is taken when an insert runs, not when it commits,
// so a row can land behind rows already shown. Rows merge by id (the same id is
// the same row) into a list kept newest id first. Time window pages back by
// occurred_at and sends the server's cursor back exactly as it came.

const EVENTS_POLL_MS = 5000;
const EVENTS_OVERLAP = 100;
const EVENTS_KEEP = 500;
const EVENTS_MAX_NAMES = 30;
const EVENTS_MAX_DAYS = 90;
const DAY_MS = 86400000;
const PRESETS = [
  ['15m', 'Last 15 minutes', 15 * 60000],
  ['1h', 'Last hour', 3600000],
  ['24h', 'Last 24 hours', DAY_MS],
  ['7d', 'Last 7 days', 7 * DAY_MS],
];
const PLATFORMS = { ios: 'iOS', android: 'Android', web: 'Web' };

let eventsRun = 0; // bumped by every restart and when the view closes: an older answer is dropped
let feed = null; // the rows on screen and where their paging stands
let evUi = null; // the Events view's nodes while it is open
let pollTimer = null;
let tickTimer = null;
const pickers = { names: [], people: [], namesKey: '', peopleKey: '', known: new Map() }; // from the last answer

/** The Events view's choices when nothing is picked yet. */
function eventsChoices() {
  return { mode: 'live', names: [], userId: '', preset: '24h', from: '', to: '', paused: false };
}

const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
});

/** An instant's New York wall clock: { year, month, day, hour, minute, second } as digits, and timeZoneName (EST or EDT). */
function nyClock(t) {
  const out = {};
  for (const { type, value } of nyParts.formatToParts(new Date(t))) out[type] = value;
  return out;
}

/** A server timestamp as epoch ms. Postgres writes up to 6 fractional digits;
 *  they are cut to 3 first, the form every browser's Date parses. */
function eventMs(s) {
  return typeof s === 'string' ? Date.parse(s.replace(/\.(\d+)/, (_, d) => `.${d.slice(0, 3).padEnd(3, '0')}`)) : NaN;
}

/** HH:MM:SS in New York, with the date when that is not today. */
function eventClock(t) {
  const p = nyClock(t);
  const now = nyClock(Date.now());
  const time = `${p.hour}:${p.minute}:${p.second}`;
  if (p.year === now.year && p.month === now.month && p.day === now.day) return time;
  const date = `${MONTHS[Number(p.month) - 1]} ${Number(p.day)}`;
  return p.year === now.year ? `${date}, ${time}` : `${date}, ${p.year}, ${time}`;
}

/** The date and time in New York to the millisecond: "Nov 2, 2026, 21:14:09.482 EST". */
function eventInstant(t) {
  const p = nyClock(t);
  const ms = String(new Date(t).getUTCMilliseconds()).padStart(3, '0');
  return `${MONTHS[Number(p.month) - 1]} ${Number(p.day)}, ${p.year}, ${p.hour}:${p.minute}:${p.second}.${ms} ${p.timeZoneName}`;
}

/** An instant as a datetime-local value in New York time: "2026-11-03T14:30". */
function nyInput(t) {
  const p = nyClock(t);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** A datetime-local value read as New York time, as epoch ms (NaN when it is not one). */
function fromNyInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return NaN;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const offset = (t) => {
    const p = nyClock(t);
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    return asUtc - Math.floor(t / 1000) * 1000;
  };
  return wall - offset(wall - offset(wall)); // the second pass settles the hours around a clock change
}

/** "just now", "3 s ago", "2 min ago", "1 hour ago". */
function sinceText(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 1) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
}

/** How late an event arrived: "3 min", "2 hours", "3 days". */
function lateText(seconds) {
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 48 * 3600) {
    const h = Math.floor(seconds / 3600);
    return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  return `${Math.floor(seconds / 86400)} days`;
}

function personName(p) {
  return typeof p?.display_name === 'string' && p.display_name.trim() ? p.display_name : 'No name';
}

/** props as stored: an object's keys, or any other value whole, under "props". */
function propEntries(props) {
  if (props === null || props === undefined) return [];
  if (typeof props === 'object' && !Array.isArray(props)) return Object.entries(props);
  return [['props', props]];
}

/** A prop value as text: a string as it is, anything else as JSON. */
function propText(v) {
  return typeof v === 'string' ? v : JSON.stringify(v) ?? NA;
}

const isEventRow = (r) => r !== null && typeof r === 'object' && Number.isSafeInteger(r.id);

function viewEvents() {
  const f = state.events;
  const ui = {};
  f.paused = false; // the mode and filters stay when the view opens again; a pause does not

  const mode = seg('Events to show', [['live', 'Live'], ['window', 'Time window']], f.mode, (m) => {
    if (m === f.mode) return;
    f.mode = m;
    ui.live.hidden = m !== 'live';
    ui.window.hidden = m !== 'window';
    restartEvents();
  });
  ui.pause = el('button', { class: 'btn', type: 'button', onclick: togglePause }, f.paused ? 'Resume' : 'Pause');
  ui.updated = el('span', { class: 'updated' });
  ui.live = el('div', { class: 'events-live', hidden: f.mode !== 'live' }, ui.pause, ui.updated);

  ui.presets = seg('Time window', PRESETS.map(([key, label]) => [key, label]), f.preset, (key) => {
    f.preset = key;
    ui.formMsg.textContent = '';
    restartEvents();
  });
  ui.presets.classList.add('seg-wrap');
  ui.from = el('input', { class: 'input', id: 'events-from', type: 'datetime-local', value: f.from });
  ui.to = el('input', { class: 'input', id: 'events-to', type: 'datetime-local', value: f.to });
  ui.formMsg = el('p', { class: 'form-msg is-error', role: 'alert' });
  const form = el('form', { class: 'events-form', novalidate: true },
    el('div', { class: 'field' }, el('label', { for: 'events-from' }, 'From'), ui.from),
    el('div', { class: 'field' }, el('label', { for: 'events-to' }, 'To'), ui.to),
    el('button', { class: 'btn btn-primary', type: 'submit' }, 'Show'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    pickWindow();
  });
  ui.window = el('div', { class: 'events-window', hidden: f.mode !== 'window' },
    ui.presets, form, el('p', { class: 'hint' }, `New York time. At most ${EVENTS_MAX_DAYS} days.`), ui.formMsg);

  ui.namesText = el('span', { class: 'picker-text' });
  ui.namesButton = el('button', {
    class: 'input picker-btn', id: 'events-names-button', type: 'button',
    'aria-expanded': 'false', 'aria-controls': 'events-names', 'aria-labelledby': 'events-names-label events-names-button',
  }, ui.namesText, el('span', { class: 'picker-mark', 'aria-hidden': 'true' }, '▾'));
  ui.namesButton.addEventListener('click', () => {
    const open = ui.namesPanel.hidden;
    ui.namesPanel.hidden = !open;
    ui.namesButton.setAttribute('aria-expanded', String(open));
  });
  ui.namesList = el('div', { class: 'picker-list' });
  ui.namesNone = empty('No event names in the last 30 days.');
  ui.namesFull = el('span', { class: 'hint' }, `At most ${EVENTS_MAX_NAMES} at a time.`);
  ui.namesClear = el('button', {
    class: 'link-btn', type: 'button',
    onclick: () => {
      f.names = [];
      updateNamePicker();
      restartEvents();
      ui.namesList.querySelector('input')?.focus();
    },
  }, 'Clear');
  ui.namesPanel = el('div', { class: 'picker-panel', id: 'events-names', hidden: true },
    ui.namesNone, ui.namesList, el('div', { class: 'picker-foot' }, ui.namesFull, ui.namesClear));
  ui.person = el('select', { class: 'input', id: 'events-person' });
  ui.person.addEventListener('change', () => {
    f.userId = ui.person.value;
    restartEvents();
  });
  const filters = el('div', { class: 'events-filters' },
    el('div', { class: 'field' }, el('span', { id: 'events-names-label' }, 'Event names'), ui.namesButton),
    el('div', { class: 'field' }, el('label', { for: 'events-person' }, 'Person'), ui.person));

  ui.status = el('div', { class: 'events-status' });
  ui.list = el('ol', { class: 'events', 'aria-label': 'Events' });
  ui.olderMsg = el('div', { class: 'events-status' });
  ui.more = el('button', { class: 'btn', type: 'button', onclick: () => loadWindow(true) }, 'Load older');
  ui.foot = el('div', { class: 'events-foot', hidden: true }, ui.olderMsg, ui.more);

  evUi = ui;
  drawNamePicker();
  drawPersonPicker();
  return [
    intro('Phones send events in batches, so a new event can take about 15 seconds to show.'),
    el('div', { class: 'view-tools' }, mode, ui.live),
    ui.window,
    filters,
    ui.namesPanel,
    ui.status,
    ui.list,
    ui.foot,
  ];
}

/** The filters every events call carries. No names key when none is picked: [] is a 400. */
function eventsFilters() {
  const f = state.events;
  const out = {};
  if (f.names.length > 0) out.names = [...f.names];
  if (f.userId) out.user_id = f.userId;
  out.include_test = state.includeTest;
  out.builds = buildsParam();
  return out;
}

function startEvents() {
  tickTimer = setInterval(tick, 1000);
  restartEvents();
}

/** Closes the feed: no more polls, and an answer still on its way is dropped. */
function stopEvents() {
  eventsRun += 1;
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  pollTimer = null;
  tickTimer = null;
  evUi = null;
  feed = null;
}

/** A new mode or filter: the list starts again from nothing. */
function restartEvents() {
  if (!evUi) return;
  eventsRun += 1;
  clearTimeout(pollTimer);
  pollTimer = null;
  feed = {
    ids: [], byId: new Map(), loaded: false, busy: false, error: null, errorOlder: false,
    updatedAt: null, next: null, from: null, to: null, dropped: false, statusKey: null, byBuilds: false,
  };
  clear(evUi.list);
  drawStatus();
  tick();
  if (state.events.mode === 'live') poll(true);
  else loadWindow(false);
}

function livePolling() {
  return evUi !== null && state.events.mode === 'live' && !state.events.paused && !document.hidden;
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = livePolling() ? setTimeout(poll, EVENTS_POLL_MS) : null;
}

/** One live call. `force` answers a person's own click even while paused. */
async function poll(force = false) {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (!evUi || state.events.mode !== 'live' || (!force && !livePolling())) return;
  const run = eventsRun;
  const target = feed;
  const body = { action: 'events', mode: 'live' };
  // the overlap brings back a row that committed after rows with higher ids were shown
  if (target.ids.length > 0) body.after_id = Math.max(0, target.ids[0] - EVENTS_OVERLAP);
  Object.assign(body, eventsFilters());
  try {
    const answer = await call(body);
    if (run !== eventsRun) return;
    syncPickers(answer);
    syncBuilds(answer);
    target.byBuilds = Array.isArray(answer.builds) && state.builds !== 'all'; // the server filtered by build
    mergeRows(Array.isArray(answer.rows) ? answer.rows : [], target.loaded);
    target.loaded = true;
    target.error = null;
    target.updatedAt = Date.now();
  } catch (e) {
    if (e instanceof SignedOut || run !== eventsRun) return;
    if (e.status === 403) {
      renderNotAdmin();
      return;
    }
    target.error = e;
  }
  drawStatus();
  tick();
  schedulePoll();
}

function togglePause() {
  const f = state.events;
  f.paused = !f.paused;
  evUi.pause.textContent = f.paused ? 'Resume' : 'Pause';
  if (f.paused) {
    clearTimeout(pollTimer);
    pollTimer = null;
  } else {
    poll(true);
  }
}

/** Live keeps the newest id first; a row that committed late takes its place by id. */
function mergeRows(rows, isNew) {
  const ids = feed.ids;
  for (const r of rows) {
    if (!isEventRow(r) || feed.byId.has(r.id)) continue;
    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ids[mid] > r.id) lo = mid + 1;
      else hi = mid;
    }
    const node = eventItem(r, isNew);
    evUi.list.insertBefore(node, lo < ids.length ? feed.byId.get(ids[lo]) : null);
    ids.splice(lo, 0, r.id);
    feed.byId.set(r.id, node);
  }
  while (ids.length > EVENTS_KEEP) {
    const id = ids.pop();
    feed.byId.get(id).remove();
    feed.byId.delete(id);
    feed.dropped = true;
  }
}

/** The form's From and To, as New York times. Checked here, so a bad window never reaches the server. */
function pickWindow() {
  const ui = evUi;
  const f = state.events;
  const from = fromNyInput(ui.from.value);
  const to = fromNyInput(ui.to.value);
  let error = '';
  if (!Number.isFinite(from) || !Number.isFinite(to)) error = 'Pick a From time and a To time.';
  else if (from >= to) error = 'The From time must be before the To time.';
  else if (to - from > EVENTS_MAX_DAYS * DAY_MS) error = `The window can be at most ${EVENTS_MAX_DAYS} days.`;
  ui.formMsg.textContent = error;
  if (error) return;
  f.preset = null;
  f.from = ui.from.value;
  f.to = ui.to.value;
  for (const button of ui.presets.children) button.setAttribute('aria-pressed', 'false');
  restartEvents();
}

/** A page of the window, newest first: the first, or the next one back with the server's cursor. */
async function loadWindow(older) {
  const f = state.events;
  const target = feed;
  if (!older) {
    let from;
    let to;
    if (f.preset) {
      to = Date.now();
      from = to - PRESETS.find(([key]) => key === f.preset)[2];
      evUi.from.value = nyInput(from);
      evUi.to.value = nyInput(to);
    } else {
      from = fromNyInput(f.from);
      to = fromNyInput(f.to);
    }
    target.from = new Date(from).toISOString();
    target.to = new Date(to).toISOString();
  }
  const run = eventsRun;
  const body = { action: 'events', mode: 'window', from: target.from, to: target.to };
  if (older) body.before = target.next; // exactly as it came: never reformatted
  Object.assign(body, eventsFilters());
  target.busy = true;
  target.error = null;
  drawStatus();
  try {
    const answer = await call(body);
    if (run !== eventsRun) return;
    syncPickers(answer);
    syncBuilds(answer);
    target.byBuilds = Array.isArray(answer.builds) && state.builds !== 'all';
    for (const r of Array.isArray(answer.rows) ? answer.rows : []) {
      if (!isEventRow(r) || target.byId.has(r.id)) continue;
      const node = eventItem(r, false);
      evUi.list.append(node);
      target.ids.push(r.id);
      target.byId.set(r.id, node);
    }
    target.next = answer.next ?? null;
    target.loaded = true;
  } catch (e) {
    if (e instanceof SignedOut || run !== eventsRun) return;
    if (e.status === 403) {
      renderNotAdmin();
      return;
    }
    target.error = e;
    target.errorOlder = older;
  }
  target.busy = false;
  drawStatus();
}

/** Loading, the empty and error states above the list, and Load older below it.
 *  Redrawn only when they change, so an alert is not read out again on every poll. */
function drawStatus() {
  const ui = evUi;
  if (!ui || !feed) return;
  const f = state.events;
  const live = f.mode === 'live';
  const filtered = f.names.length > 0 || f.userId !== '';
  const top = [];
  if (feed.error && !feed.errorOlder) {
    top.push(['error', feed.loaded && live
      ? `The last update failed (${errorText(feed.error)}).`
      : `The events did not load (${errorText(feed.error)}).`]);
  } else if (!feed.loaded) {
    top.push(['loading']);
  }
  if (feed.loaded && feed.ids.length === 0) {
    // under a build choice the way back to every build comes with it; the filters' words stay when they are set
    top.push([feed.byBuilds ? 'builds' : 'empty', live
      ? (filtered ? 'No events match these filters yet.' : feed.byBuilds ? NO_BUILD_EVENTS : 'No events yet.')
      : (filtered ? 'No events match these filters in this window.' : feed.byBuilds ? 'No events from these builds in this window.' : 'No events in this window.')]);
  }
  if (live && feed.dropped) top.push(['note', `Only the newest ${int(EVENTS_KEEP)} are kept on screen.`]);
  const older = !live && feed.error && feed.errorOlder ? `The older events did not load (${errorText(feed.error)}).` : '';
  const key = JSON.stringify([top, older]);
  if (key !== feed.statusKey) {
    feed.statusKey = key;
    clear(ui.status);
    add(ui.status, top.map(([kind, text]) => {
      if (kind === 'error') return problem(text, live ? () => poll(true) : restartEvents);
      if (kind === 'loading') return loading();
      if (kind === 'builds') return el('div', { class: 'empty' }, buildsEmptyLine(text));
      return kind === 'empty' ? empty(text) : note(text);
    }));
    clear(ui.olderMsg);
    if (older) ui.olderMsg.append(problem(older, null));
  }
  ui.foot.hidden = live || (feed.next === null && !older);
  ui.more.hidden = feed.next === null;
  ui.more.disabled = feed.busy;
  ui.more.textContent = feed.busy && feed.loaded ? 'Loading' : 'Load older';
}

/** "Updated 3 s ago", once a second while the view is open. */
function tick() {
  if (!evUi || !feed) return;
  evUi.updated.textContent = feed.updatedAt === null ? '' : `Updated ${sinceText(Date.now() - feed.updatedAt)}`;
}

/** names and people come with every answer; the pickers are redrawn only when they change. */
function syncPickers(answer) {
  const names = Array.isArray(answer.names) ? answer.names.filter((n) => typeof n === 'string') : [];
  const people = Array.isArray(answer.people) ? answer.people.filter((p) => typeof p?.id === 'string') : [];
  for (const p of people) pickers.known.set(p.id, p);
  const namesKey = JSON.stringify(names);
  if (namesKey !== pickers.namesKey) {
    pickers.namesKey = namesKey;
    pickers.names = names;
    drawNamePicker();
  }
  const peopleKey = JSON.stringify(people);
  if (peopleKey !== pickers.peopleKey) {
    pickers.peopleKey = peopleKey;
    pickers.people = people;
    drawPersonPicker();
  }
}

/** The event names as checkboxes. A name picked earlier stays listed after it drops out of the 30 days. */
function drawNamePicker() {
  const ui = evUi;
  if (!ui) return;
  const f = state.events;
  const focused = ui.namesList.contains(document.activeElement) ? document.activeElement.value : null;
  clear(ui.namesList);
  for (const name of [...new Set([...pickers.names, ...f.names])].sort()) {
    const box = el('input', { type: 'checkbox', value: name });
    box.addEventListener('change', () => {
      f.names = box.checked ? [...f.names, name].sort() : f.names.filter((n) => n !== name);
      updateNamePicker();
      restartEvents();
    });
    ui.namesList.append(el('label', { class: 'pick' }, box, el('span', {}, name)));
    if (name === focused) box.focus();
  }
  ui.namesNone.hidden = ui.namesList.childElementCount > 0;
  updateNamePicker();
}

function updateNamePicker() {
  const ui = evUi;
  const picked = new Set(state.events.names);
  const full = picked.size >= EVENTS_MAX_NAMES;
  for (const box of ui.namesList.querySelectorAll('input')) {
    box.checked = picked.has(box.value);
    box.disabled = full && !box.checked;
  }
  ui.namesFull.hidden = !full;
  ui.namesClear.hidden = picked.size === 0;
  ui.namesText.textContent = picked.size === 0 ? 'All events' : [...picked].join(', ');
}

/** Everyone, then the people of the last 30 days. A person picked earlier stays listed. */
function drawPersonPicker() {
  const ui = evUi;
  if (!ui) return;
  const f = state.events;
  const people = [...pickers.people];
  if (f.userId && !people.some((p) => p.id === f.userId)) {
    people.push(pickers.known.get(f.userId) ?? { id: f.userId, display_name: null, test: false });
  }
  const label = (p) => `${personName(p)}${p.test === true ? ' (test)' : ''}`;
  const uses = new Map();
  for (const p of people) uses.set(label(p), (uses.get(label(p)) ?? 0) + 1);
  clear(ui.person);
  add(ui.person, [
    el('option', { value: '' }, 'Everyone'),
    // two people with one name are told apart by the start of their id
    people.map((p) => el('option', { value: p.id }, uses.get(label(p)) > 1 ? `${label(p)}, ${p.id.slice(0, 8)}` : label(p))),
  ]);
  ui.person.value = f.userId;
}

function eventItem(r, isNew) {
  const at = eventMs(r.occurred_at);
  const lateBy = (eventMs(r.received_at) - at) / 1000;
  const props = propEntries(r.props);
  const device = [PLATFORMS[r.platform] ?? r.platform, r.app_version].filter((s) => typeof s === 'string' && s !== '').join(' ');
  const dev = r.channel === 'dev';
  const prop = ([k, v]) => el('span', { class: 'ev-prop' }, el('span', { class: 'ev-key' }, `${k}:`), ' ', propText(v));
  const row = el('button', { class: 'ev-row', type: 'button', 'aria-expanded': 'false' },
    el('span', { class: 'ev-time' }, Number.isFinite(at) ? el('time', { datetime: new Date(at).toISOString() }, eventClock(at)) : NA),
    el('span', { class: 'ev-name' }, r.name),
    el('span', { class: 'ev-meta' },
      el('span', { class: 'ev-who' },
        el('span', { class: 'ev-person' }, personName(r.user)),
        r.user?.test === true && el('span', { class: 'chip' }, 'test')),
      r.screen && el('span', { class: 'ev-screen' }, r.screen),
      (device || dev) && el('span', { class: 'ev-device' },
        device && el('span', { class: 'ev-platform' }, device),
        dev && el('span', { class: 'chip' }, 'dev'))),
    props.length > 0 && el('span', { class: 'ev-props' },
      props.slice(0, 3).map(prop),
      props.length > 3 && el('span', { class: 'ev-prop ev-key' }, `+${props.length - 3} more`)),
    lateBy > 60 && el('span', { class: 'ev-late' }, `arrived ${lateText(lateBy)} late`));
  const more = el('div', { class: 'ev-more', hidden: true });
  row.addEventListener('click', () => {
    const open = more.hidden;
    if (open && !more.firstChild) add(more, eventDetail(r));
    more.hidden = !open;
    row.setAttribute('aria-expanded', String(open));
  });
  return el('li', { class: cls('event', isNew && 'is-new'), 'data-id': r.id }, row, more);
}

/** The opened row: every field the events action returns (ADMIN_DASHBOARD.md 6.2), labelled,
 *  then every prop, then Copy JSON with the row exactly as it came. */
function eventDetail(r) {
  const pair = (label, ...value) => [el('dt', {}, label), el('dd', {}, value)];
  const text = (v) => (v === null || v === undefined || v === '' ? NA : String(v));
  const time = (raw) => {
    const t = eventMs(raw);
    return [Number.isFinite(t) ? eventInstant(t) : NA, el('span', { class: 'ev-raw' }, text(raw))];
  };
  const props = propEntries(r.props);
  const copy = el('button', { class: 'btn', type: 'button' }, 'Copy JSON');
  let reset = null;
  copy.addEventListener('click', async () => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
      copied = true;
    } catch {
      // no clipboard in this page, or the browser refused it
    }
    copy.textContent = copied ? 'Copied' : 'Could not copy';
    clearTimeout(reset);
    reset = setTimeout(() => {
      copy.textContent = 'Copy JSON';
    }, 2000);
  });
  return [
    el('dl', { class: 'ev-fields' },
      pair('Event id', text(r.id)),
      pair('Event', text(r.name)),
      pair('Occurred', time(r.occurred_at)),
      pair('Received', time(r.received_at)),
      pair('Person', personName(r.user)),
      pair('User id', text(r.user?.id)),
      pair('Test account', r.user?.test === true ? 'Yes' : 'No'),
      pair('Screen', text(r.screen)),
      pair('Platform', text(r.platform)),
      pair('App version', text(r.app_version)),
      pair('Build', text(r.build)),
      pair('OS', text(r.os_version)),
      pair('Session', text(r.session_id)),
      pair('Order in session', text(r.seq)),
      pair('Schema version', text(r.schema_version)),
      pair('Build channel', text(r.channel)),
      pair('Commit', text(r.commit)),
      pair('Phone model', text(r.device_model)),
      pair('Language', text(r.locale)),
      pair('Time zone', text(r.timezone)),
      pair('Online', r.is_online === true ? 'Yes' : r.is_online === false ? 'No' : NA)),
    el('div', { class: 'ev-section' },
      el('p', { class: 'ev-head' }, 'Props'),
      props.length > 0
        ? el('dl', { class: 'ev-fields' }, props.map(([k, v]) => pair(k, propText(v))))
        : el('p', { class: 'muted' }, 'None')),
    el('div', {}, copy),
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
      : noEvents(m)),
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
      note('From the anonymous record kept when someone deletes their account: a sign-up week, a deletion week and a platform. Test accounts are never in it.')),
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
      : noEvents(m)),
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
  // the live Events feed asks only while the tab is visible, and catches up on return
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(pollTimer);
      pollTimer = null;
    } else {
      poll();
    }
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
