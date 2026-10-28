import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../assets/speaking.js');

test('istanbulToday uses Istanbul, not the local zone', () => {
  assert.equal(S.istanbulToday(new Date('2026-10-26T22:30:00Z')), '2026-10-27'); // 01:30 in Istanbul
  assert.equal(S.istanbulToday(new Date('2026-10-26T20:59:00Z')), '2026-10-26');
});

test('periodEnd', () => {
  assert.equal(S.periodEnd('2026-02'), '2026-02-28');
  assert.equal(S.periodEnd('2023'), '2023-12-31');
  assert.equal(S.periodEnd('2026-10-09'), '2026-10-09');
});

test('daysBetween counts whole days', () => {
  assert.equal(S.daysBetween('2026-10-23', '2026-10-27'), 4);
  assert.equal(S.daysBetween('2026-10-27', '2026-10-27'), 0);
});

test('daysLabel', () => {
  assert.equal(S.daysLabel(0), 'today');
  assert.equal(S.daysLabel(1), 'tomorrow');
  assert.equal(S.daysLabel(4), 'in 4 days');
});

test('event today is featured', () => {
  const r = S.partition([{ date: '2026-10-27' }, { date: '2026-10-09' }], '2026-10-27');
  assert.equal(r.featured.date, '2026-10-27');
  assert.equal(r.past.length, 1);
});

test('partial dates are past even in the current month', () => {
  assert.equal(S.partition([{ date: '2026-10' }], '2026-10-01').featured, null);
});

test('second upcoming item goes to upcoming, earliest first', () => {
  const r = S.partition([{ date: '2026-12-01' }, { date: '2026-11-02' }, { date: '2026-11-20' }], '2026-10-23');
  assert.deepEqual([r.featured.date, ...r.upcoming.map(i => i.date)], ['2026-11-02', '2026-11-20', '2026-12-01']);
});

test('past sorted newest first, ties stable', () => {
  const r = S.partition([{ date: '2023', id: 'a' }, { date: '2026-04', id: 'b' }, { date: '2023', id: 'c' }, { date: '2026-04', id: 'd' }], '2026-10-23');
  assert.deepEqual(r.past.map(i => i.id), ['b', 'd', 'a', 'c']);
});

test('fold keeps the first five rows and counts the rest on the button', () => {
  const items = Array.from({ length: 8 }, () => ({ hidden: false }));
  const attrs = {};
  const btn = { setAttribute: (k, v) => { attrs[k] = v; }, textContent: '' };
  S.fold(items, btn, false);
  assert.deepEqual(items.map(i => i.hidden), [false, false, false, false, false, true, true, true]);
  assert.equal(attrs['aria-expanded'], 'false');
  assert.equal(btn.textContent, 'show 3 more ↓');
  S.fold(items, btn, true);
  assert.ok(items.every(i => !i.hidden));
  assert.equal(attrs['aria-expanded'], 'true');
  assert.equal(btn.textContent, 'show fewer ↑');
});
