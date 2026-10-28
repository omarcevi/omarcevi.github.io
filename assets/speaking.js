// Speaking: decides which talk is next from the dates on the page, so a talk
// moves from "next" to the past lists by itself once its day is over.
// Dates are compared as Istanbul calendar days, whatever the visitor's zone.
(function (root) {
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var FULL = /^\d{4}-\d{2}-\d{2}$/;

  function istanbulToday(now) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }

  // "2026-10" -> "2026-10-31", "2023" -> "2023-12-31"; full dates pass through
  function periodEnd(date) {
    if (FULL.test(date)) return date;
    var p = date.split('-'), y = +p[0];
    if (p.length === 1) return y + '-12-31';
    var last = new Date(Date.UTC(y, +p[1], 0)).getUTCDate();
    return p[0] + '-' + p[1] + '-' + (last < 10 ? '0' : '') + last;
  }

  function utc(date) { var p = date.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }

  function daysBetween(from, to) { return Math.round((utc(to) - utc(from)) / 864e5); }

  function daysLabel(n) { return n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days'; }

  // featured: the earliest dated item still to come (today counts); undated months/years are always past
  function partition(items, today) {
    var up = [], past = [];
    items.forEach(function (it, i) {
      (FULL.test(it.date) && it.date >= today ? up : past).push({ it: it, i: i });
    });
    up.sort(function (a, b) { return a.it.date < b.it.date ? -1 : a.it.date > b.it.date ? 1 : a.i - b.i; });
    past.sort(function (a, b) {
      var x = periodEnd(a.it.date), y = periodEnd(b.it.date);
      return x > y ? -1 : x < y ? 1 : a.i - b.i;
    });
    var unwrap = function (w) { return w.it; };
    return { featured: up.length ? up[0].it : null, upcoming: up.slice(1).map(unwrap), past: past.map(unwrap) };
  }

  function el(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function noun(n, word) { return n === 1 ? word : word + 's'; }

  // ?today=YYYY-MM-DD pins the date (used by tests); otherwise today in Istanbul
  function pickToday(doc) {
    var m = /[?&]today=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(doc.location ? doc.location.search : '');
    return m ? m[1] : istanbulToday(new Date());
  }

  function fillCard(doc, card, li) {
    var p = li.getAttribute('data-date').split('-');
    var cal = el(doc, 'div', 'up-cal');
    cal.appendChild(el(doc, 'b', null, MONTHS[+p[1] - 1].toUpperCase()));
    cal.appendChild(el(doc, 'span', null, String(+p[2])));
    var body = el(doc, 'div');
    body.appendChild(li.querySelector('.item-title').cloneNode(true));
    var meta = ['data-event', 'data-place', 'data-format', 'data-lang'].map(function (k) { return li.getAttribute(k); }).filter(Boolean);
    body.appendChild(el(doc, 'div', 'item-meta', meta.join(' · ')));
    var mats = li.querySelector('.mats');
    if (mats) body.appendChild(mats.cloneNode(true));
    card.appendChild(cal);
    card.appendChild(body);
    var url = li.getAttribute('data-url');
    if (url) {
      var go = el(doc, 'a', 'up-go', 'event page ↗');
      go.href = url;
      card.appendChild(go);
    }
    card.hidden = false;
  }

  function fillStrip(doc, next, featured, today) {
    while (next.firstChild) next.removeChild(next.firstChild);
    if (featured) {
      var p = featured.date.split('-');
      next.appendChild(doc.createTextNode('next talk · '));
      var name = el(doc, 'a', null, featured.li.getAttribute('data-event'));
      name.href = '#speaking'; // down to its card
      next.appendChild(name);
      next.appendChild(doc.createTextNode(' · ' + (+p[2]) + ' ' + MONTHS[+p[1] - 1] + ' ' + p[0] + ' · '));
      next.appendChild(el(doc, 'span', 'soon', daysLabel(daysBetween(today, featured.date))));
    } else {
      next.appendChild(doc.createTextNode('no talks scheduled · '));
      var a = el(doc, 'a', null, 'invite me to speak →');
      a.href = '#contact';
      next.appendChild(a);
    }
    next.hidden = false;
  }

  var SHOWN = 5; // rows a list shows before its "show more" button

  // the first SHOWN rows stay; the rest wait behind the button
  function fold(items, btn, open) {
    items.forEach(function (li, i) { li.hidden = !open && i >= SHOWN; });
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? 'show fewer ↑' : 'show ' + (items.length - SHOWN) + ' more ↓';
  }

  function foldList(doc, list) {
    var items = [].slice.call(list.children);
    if (items.length <= SHOWN) return;
    var btn = el(doc, 'button', 'fold'), open = false;
    btn.type = 'button';
    btn.setAttribute('aria-controls', list.id);
    fold(items, btn, open);
    btn.addEventListener('click', function () {
      open = !open;
      fold(items, btn, open);
      if (!open && btn.getBoundingClientRect().top < 0) btn.scrollIntoView({ block: 'center' }); // folding up from the bottom of a long list
    });
    list.parentNode.insertBefore(btn, list.nextSibling);
  }

  function initSpeaking(doc) {
    var talks = doc.getElementById('talk-list'), shops = doc.getElementById('workshop-list');
    var card = doc.getElementById('up-card'), next = doc.getElementById('strip-next'), count = doc.getElementById('strip-count');
    if (!talks || !shops) return;
    var items = [];
    [talks, shops].forEach(function (list) {
      [].forEach.call(list.children, function (li) { items.push({ date: li.getAttribute('data-date') || '', li: li, list: list }); });
    });
    var today = pickToday(doc), r = partition(items, today);

    r.upcoming.forEach(function (it) {
      var mats = it.li.querySelector('.mats');
      if (!mats) { mats = el(doc, 'div', 'mats'); it.li.querySelector('.item-title').parentNode.appendChild(mats); }
      mats.appendChild(el(doc, 'span', 'tag', 'upcoming'));
    });
    r.upcoming.concat(r.past).forEach(function (it) { it.list.appendChild(it.li); }); // upcoming first, then newest past
    if (r.featured && card) { fillCard(doc, card, r.featured.li); r.featured.li.parentNode.removeChild(r.featured.li); }
    foldList(doc, talks);
    foldList(doc, shops);
    if (next) fillStrip(doc, next, r.featured, today);
    if (count) { // only what has already happened
      var given = function (list) { return r.past.filter(function (it) { return it.list === list; }).length; };
      var t = given(talks), w = given(shops);
      count.textContent = '';
      count.appendChild(el(doc, 'b', null, String(t)));
      count.appendChild(doc.createTextNode(' ' + noun(t, 'talk') + ' · '));
      count.appendChild(el(doc, 'b', null, String(w)));
      count.appendChild(doc.createTextNode(' ' + noun(w, 'workshop')));
    }
  }

  var api = { istanbulToday: istanbulToday, periodEnd: periodEnd, daysBetween: daysBetween, daysLabel: daysLabel, partition: partition, fold: fold, initSpeaking: initSpeaking };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.Speaking = api;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { initSpeaking(document); });
    else initSpeaking(document);
  }
})(this);
