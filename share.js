/*
 * share.js: the one script behind /l/<id> (a shared log) and /s/<id> (a menu
 * scan's shared top picks). The page's only data source is the public
 * share-view Edge Function (glug-app, docs/architecture/SHARE_LINKS_PLAN.md,
 * sections 9 and 10): one plain GET with no custom header and no credential,
 * so no preflight; no cookie, no storage, no analytics, no other request.
 *
 * Every string from the answer goes in with textContent (nothing in this file
 * assigns markup); an avatar <img> is set only for a URL under the project's
 * public avatars bucket, otherwise the initial is drawn; the Open in Glug
 * button is glug://l/<id> or glug://s/<id>, built from the validated id alone,
 * and never an automatic redirect (Safari shows an error dialog when the app
 * is not installed). The pages carry a CSP of script-src 'self', so this file
 * is loaded with defer and the HTML has no inline script, style or handler.
 *
 * States: loading (the logo and a placeholder line), visible (the card and
 * the button), private (one line and nothing about the item or the person),
 * gone (one line), error (one line; a reload retries). A path that is not a
 * well-formed UUID is gone, with no request made.
 */
(function () {
  'use strict';

  var FUNCTION_URL = 'https://txjfbiriyceabushptlp.supabase.co/functions/v1/share-view';
  var AVATAR_PREFIX = 'https://txjfbiriyceabushptlp.supabase.co/storage/v1/object/public/avatars/';
  var AVATAR_REST = /^[A-Za-z0-9._\/-]+$/;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var PATH = /^\/(l|s)\/([^\/]+)\/?$/;
  var KIND_OF_SEGMENT = { l: 'log', s: 'scan' };
  var SEGMENT_OF_KIND = { log: 'l', scan: 's' };
  var UNKNOWN_VINTAGE = 'UNKNOWN';
  /* Fixed English abbreviations, never Intl output, so "Sep" never becomes
     "Sept" with a browser's ICU data: the app's table (glug-app
     src/lib/format.ts). */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var SVG_NS = 'http://www.w3.org/2000/svg';
  // Phosphor Icons, MapPin (light), MIT. The app's PlacePill draws the same pin.
  var MAP_PIN_D =
    'M128,66a38,38,0,1,0,38,38A38,38,0,0,0,128,66Zm0,64a26,26,0,1,1,26-26A26,26,0,0,1,128,130Zm0-112a86.1,86.1,0,0,0-86,86c0,30.91,14.34,63.74,41.47,94.94a252.32,252.32,0,0,0,41.09,38,6,6,0,0,0,6.88,0,252.32,252.32,0,0,0,41.09-38c27.13-31.2,41.47-64,41.47-94.94A86.1,86.1,0,0,0,128,18Zm0,206.51C113,212.93,54,163.62,54,104a74,74,0,0,1,148,0C202,163.62,143,212.93,128,224.51Z';

  /* The rating words (the app's wineRatingLabel) and the colour dots
     (WineColorDot). Looked up with hasOwn, never a bare index. */
  var RATINGS = { poor: 'Poor', fair: 'Fair', good: 'Good', great: 'Great', superb: 'Superb' };
  var COLORS = { Red: 'red', White: 'white', Orange: 'orange' };
  COLORS['Ros' + String.fromCharCode(233)] = 'rose';
  var MIDDLE_DOT = ' ' + String.fromCharCode(183) + ' ';

  /* The page's words, in one place for Sadhana's pass. The Rare word is the
     app's RARE_COPY.badge. */
  var COPY = {
    unknownName: 'Someone',
    unknownWine: "This wine isn't available right now",
    tried: 'tried',
    at: 'at',
    picksAt: 'My top picks at',
    picks: 'My top picks',
    rare: 'Rare',
    rated: 'Rated ',
    percentMatch: ' percent match',
    privateLog: 'This log is private',
    privateScan: 'These picks are private',
    gone: 'This is no longer available.',
    error: "Couldn't load this. Try again in a moment.",
  };

  var stage = document.getElementById('share-stage');
  var button = document.getElementById('open-in-glug');
  var page = document.querySelector('[data-share-kind]');
  var pageKind = page ? page.getAttribute('data-share-kind') : null;

  function hasOwn(table, key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
  }

  function str(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  function vintageOf(value) {
    var v = str(value);
    return v && v.trim() !== UNKNOWN_VINTAGE ? v : null;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function svg(tag) {
    return document.createElementNS(SVG_NS, tag);
  }

  function text(value) {
    return document.createTextNode(value);
  }

  /* Replace what the stage holds; the stage is aria-live, so the new content
     is read out. */
  function show(node) {
    while (stage.firstChild) stage.removeChild(stage.firstChild);
    stage.appendChild(node);
    stage.removeAttribute('aria-busy');
  }

  function showLine(sentence) {
    button.hidden = true;
    button.removeAttribute('href');
    show(el('h1', 'tagline', sentence));
  }

  /* The kind and the id from the path, or null: not a well-formed UUID, or a
     segment that is not this page's. The raw path is tested, so a percent
     escape never passes. */
  function parsePath() {
    var m = PATH.exec(location.pathname);
    if (!m) return null;
    var kind = hasOwn(KIND_OF_SEGMENT, m[1]) ? KIND_OF_SEGMENT[m[1]] : null;
    if (!kind || kind !== pageKind) return null;
    if (!UUID.test(m[2])) return null;
    return { kind: kind, id: m[2].toLowerCase() };
  }

  /* One request. A network failure, a non-2xx answer or a body that is not
     JSON is the error state; a reload retries. */
  function load(link) {
    var url = FUNCTION_URL + '?k=' + encodeURIComponent(link.kind) + '&id=' + encodeURIComponent(link.id);
    fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit' })
      .then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then(function (body) {
        render(link, body);
      })
      .catch(function () {
        showLine(COPY.error);
      });
  }

  function render(link, body) {
    if (!body || typeof body !== 'object' || body.kind !== link.kind) return showLine(COPY.error);
    switch (body.status) {
      case 'visible': {
        var item = link.kind === 'log' ? body.log : body.scan;
        if (!item || typeof item !== 'object') return showLine(COPY.error);
        var card = link.kind === 'log' ? logCard(body.sharer, item) : scanCard(body.sharer, item);
        show(card);
        button.href = 'glug://' + SEGMENT_OF_KIND[link.kind] + '/' + link.id;
        button.hidden = false;
        return;
      }
      case 'private':
        return showLine(link.kind === 'log' ? COPY.privateLog : COPY.privateScan);
      case 'gone':
        return showLine(COPY.gone);
      default:
        return showLine(COPY.error);
    }
  }

  /* ── The pieces the two cards share ─────────────────────────────── */

  function initialOf(name) {
    var chars = Array.from((name || '').trim());
    return chars.length ? chars[0].toLocaleUpperCase() : '?';
  }

  function isAvatarUrl(value) {
    if (typeof value !== 'string' || value.indexOf(AVATAR_PREFIX) !== 0) return false;
    var rest = value.slice(AVATAR_PREFIX.length);
    return AVATAR_REST.test(rest) && rest.indexOf('..') === -1;
  }

  /* The avatar: the photo when its URL is under the public avatars bucket,
     else the initial; a photo that fails to load falls back to the initial.
     Decoration: the name beside it is the accessible text. */
  function avatar(name, url) {
    var circle = el('span', 'share-avatar');
    circle.setAttribute('aria-hidden', 'true');
    var initial = el('span', 'share-initial', initialOf(name));
    if (isAvatarUrl(url)) {
      var img = el('img', null);
      img.alt = '';
      img.addEventListener('error', function () {
        if (img.parentNode === circle) circle.replaceChild(initial, img);
      });
      img.src = url;
      circle.appendChild(img);
    } else {
      circle.appendChild(initial);
    }
    return circle;
  }

  /* The card's head: the sharer and the logo. */
  function header(sharer) {
    var s = sharer && typeof sharer === 'object' ? sharer : {};
    var name = str(s.name);
    var head = el('div', 'share-card-head');
    var person = el('div', 'share-person');
    person.appendChild(avatar(name, s.avatar_url));
    person.appendChild(el('span', 'share-name', name || COPY.unknownName));
    head.appendChild(person);
    var logo = el('img', 'share-card-logo');
    logo.src = '/assets/glug-logo-green.png';
    logo.alt = 'glug';
    logo.width = 956;
    logo.height = 711;
    head.appendChild(logo);
    return head;
  }

  /* The Rare badge: a 9 px filled diamond and the word, in antique gold. */
  function rareBadge() {
    var badge = el('span', 'share-rare');
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', COPY.rare);
    var icon = svg('svg');
    icon.setAttribute('viewBox', '0 0 10 10');
    icon.setAttribute('width', '9');
    icon.setAttribute('height', '9');
    icon.setAttribute('aria-hidden', 'true');
    var path = svg('path');
    path.setAttribute('d', 'M5 0L10 5 5 10 0 5z');
    path.setAttribute('fill', 'currentColor');
    icon.appendChild(path);
    badge.appendChild(icon);
    badge.appendChild(text(COPY.rare));
    return badge;
  }

  /* The wine's name with its vintage after it, regular and muted. */
  function wineLine(className, name, vintage) {
    var line = el('span', className, name);
    if (vintage) {
      line.appendChild(text(' '));
      line.appendChild(el('span', 'share-vintage', vintage));
    }
    return line;
  }

  /* The short date, month first: "Nov 2" this year, "Nov 2, 2025" in another,
     in the visitor's local time, whatever their locale. The app's one short
     date (glug-app src/lib/format.ts formatShortDate); change both together.
     Null for a value that is not a date. */
  function dateLabel(value) {
    if (typeof value !== 'string') return null;
    var then = new Date(value);
    if (isNaN(then.getTime())) return null;
    var label = MONTHS[then.getMonth()] + ' ' + then.getDate();
    if (then.getFullYear() !== new Date().getFullYear()) label += ', ' + then.getFullYear();
    return { label: label, iso: then.toISOString() };
  }

  /* ── The log card ───────────────────────────────────────────────── */

  function placePill(name, neighborhood) {
    var pill = el('span', 'share-place');
    var pin = svg('svg');
    pin.setAttribute('viewBox', '0 0 256 256');
    pin.setAttribute('width', '14');
    pin.setAttribute('height', '14');
    pin.setAttribute('aria-hidden', 'true');
    pin.setAttribute('class', 'share-pin');
    var path = svg('path');
    path.setAttribute('d', MAP_PIN_D);
    path.setAttribute('fill', 'currentColor');
    pin.appendChild(path);
    pill.appendChild(pin);
    pill.appendChild(el('span', 'share-place-name', name));
    // The neighbourhood is read out, not shown: the app's pill names the
    // place as "Elder, Manhattan" and shows the name alone.
    if (neighborhood) pill.appendChild(el('span', 'share-sr', ', ' + neighborhood));
    return pill;
  }

  /* The colour dot and word, " · " and the date; a missing value goes with
     its separator. Null when there is nothing to print. */
  function metaLine(log) {
    var meta = el('p', 'share-meta');
    var colorKey = hasOwn(COLORS, log.color) ? COLORS[log.color] : null;
    // The word is color_word (Sparkling or Fortified when that is the type,
    // else the colour); without one, the colour itself only when it is one
    // of the four the dot knows.
    var word = str(log.color_word) || (colorKey ? log.color : null);
    if (word) {
      var kind = el('span', 'share-kind');
      if (colorKey) {
        var dot = el('span', 'share-dot share-dot-' + colorKey);
        dot.setAttribute('aria-hidden', 'true');
        kind.appendChild(dot);
      }
      kind.appendChild(text(word));
      meta.appendChild(kind);
    }
    var date = dateLabel(log.logged_at);
    if (word && date) {
      var sep = el('span', null, MIDDLE_DOT);
      sep.setAttribute('aria-hidden', 'true');
      meta.appendChild(sep);
    }
    if (date) {
      var time = el('time', null, date.label);
      time.dateTime = date.iso;
      meta.appendChild(time);
    }
    return meta.firstChild ? meta : null;
  }

  function logCard(sharer, log) {
    var card = el('article', 'share-card');
    card.setAttribute('data-share-card', 'log');
    card.appendChild(header(sharer));

    var main = el('div', 'share-main');
    main.appendChild(el('p', 'share-lead', COPY.tried));
    var body = el('div', 'share-body');
    var wine = el('p', 'share-wine');
    wine.appendChild(wineLine('share-wine-name', str(log.title) || COPY.unknownWine, vintageOf(log.vintage)));
    body.appendChild(wine);
    var badges = el('div', 'share-badges');
    if (hasOwn(RATINGS, log.rating)) {
      var word = RATINGS[log.rating];
      var chip = el('span', 'share-verdict share-verdict-' + log.rating, word);
      chip.setAttribute('role', 'img');
      chip.setAttribute('aria-label', COPY.rated + word);
      badges.appendChild(chip);
    }
    if (log.is_rare === true) badges.appendChild(rareBadge());
    if (badges.firstChild) body.appendChild(badges);
    main.appendChild(body);
    card.appendChild(main);

    var foot = el('div', 'share-foot');
    var place = log.place && typeof log.place === 'object' ? log.place : null;
    var placeName = place ? str(place.name) : null;
    if (placeName) {
      var line = el('div', 'share-place-line');
      line.appendChild(el('span', 'share-at', COPY.at));
      line.appendChild(placePill(placeName, str(place.neighborhood)));
      foot.appendChild(line);
    }
    var meta = metaLine(log);
    if (meta) foot.appendChild(meta);
    if (foot.firstChild) card.appendChild(foot);
    return card;
  }

  /* ── The scan card ──────────────────────────────────────────────── */

  /* True when a wine's name already begins with its producer ("Domaine Leflaive
     Puligny-Montrachet" under "Domaine Leflaive"), so the producer is named
     once, by the name alone. Case-insensitive over the trimmed values and
     whole-word: the name has to end there or go on with a space or
     punctuation, so a producer "Pia" does not swallow "Piazza Red". The log
     row's rule (glug-app src/components/feed/feedLogic.ts nameRepeatsProducer);
     change both together. */
  function nameRepeatsProducer(producer, name) {
    var p = producer.trim();
    var n = name.trim();
    return p !== '' && n.slice(0, p.length).toLowerCase() === p.toLowerCase() && !/[\p{L}\p{N}]/u.test(n.charAt(p.length));
  }

  function pickRow(pick) {
    var row = el('li', 'share-pick');
    var column = el('div', 'share-pick-text');
    var producerLine = el('span', 'share-pick-producer-line');
    var producer = str(pick.producer);
    var name = str(pick.name);
    if (producer && name && nameRepeatsProducer(producer, name)) producer = null;
    if (producer) producerLine.appendChild(el('span', 'share-pick-producer', producer));
    if (pick.rare === true) producerLine.appendChild(rareBadge());
    if (producerLine.firstChild) column.appendChild(producerLine);
    column.appendChild(wineLine('share-pick-name', name || COPY.unknownWine, vintageOf(pick.vintage)));
    row.appendChild(column);
    if (typeof pick.match === 'number' && isFinite(pick.match)) {
      var match = Math.round(pick.match);
      var pill = el('span', 'share-match', match + '%');
      pill.setAttribute('role', 'img');
      pill.setAttribute('aria-label', match + COPY.percentMatch);
      row.appendChild(pill);
    }
    return row;
  }

  function scanCard(sharer, scan) {
    var card = el('article', 'share-card');
    card.setAttribute('data-share-card', 'scan');
    card.appendChild(header(sharer));

    var main = el('div', 'share-main');
    var venue = str(scan.venue);
    if (venue) {
      main.appendChild(el('p', 'share-lead', COPY.picksAt));
      main.appendChild(el('p', 'share-venue', venue));
    } else {
      main.appendChild(el('p', 'share-venue', COPY.picks));
    }
    card.appendChild(main);

    var list = el('ul', 'share-picks');
    var picks = Array.isArray(scan.picks) ? scan.picks.slice(0, 3) : [];
    picks.forEach(function (pick) {
      if (pick && typeof pick === 'object') list.appendChild(pickRow(pick));
    });
    if (list.firstChild) card.appendChild(list);
    return card;
  }

  /* ── Start ──────────────────────────────────────────────────────── */

  if (!stage || !button || !pageKind) return;
  var link = parsePath();
  if (!link) {
    showLine(COPY.gone);
    return;
  }
  load(link);
})();
