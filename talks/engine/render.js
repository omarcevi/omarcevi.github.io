// Slide rendering: builds (data-step), poll/results views, QR slots, diagrams, demos.
// Slide HTML comes from the decrypted deck (presenter-authored). Nothing from phones is ever rendered as text.
import { el, qrSvg } from './util.js';
import { renderDiagram } from './diagram.js';
import { DemoPlayer } from './demo.js';
import { renderMap, renderSteps } from './archmap.js';

export const STEP_COLORS = { 0: 'none', 1: 'blue', 2: 'red', 3: 'yellow', 4: 'green', 5: 'blue' };

export function applySteps(root, step) {
  root.querySelectorAll('[data-step]').forEach((n) => n.classList.toggle('built', step >= +n.dataset.step));
  root.querySelectorAll('[data-until]').forEach((n) => n.classList.toggle('gone', step >= +n.dataset.until));
  root.dataset.stepNow = step;
}

export class SlideView {
  // ctx: { live: () => LiveSession|null, liveUrl: () => string, publicUrl, onDemoStep }
  constructor(host, deck, ctx) {
    this.host = host; this.deck = deck; this.ctx = ctx;
    this.cur = null; this.node = null; this.cleanup = []; this.poll = null; this.demo = null;
  }

  show(pos) {
    const changed = !this.cur || this.cur.slide !== pos.slide;
    const prev = this.cur;
    if (changed) this.mount(pos.slide, prev);
    this.cur = pos;
    applySteps(this.node, pos.step);
    if (this.demo) this.demo.go(pos.step, changed ? null : prev.step);
    if (this.poll) this.poll.setStep(pos.step);
  }

  mount(i, prev) {
    this.cleanup.forEach((f) => f()); this.cleanup = []; this.poll = null; this.demo = null;
    const s = this.deck.slides[i];
    const node = el('section', { class: `slide type-${s.type} accent-${s.accent || 'none'}`, 'data-id': s.id, 'data-index': i });
    node.innerHTML = s.html || '';
    this.host.replaceChildren(node);
    this.node = node;

    // architecture map: a slot in the slide (large variants) or the strip across the top of the canvas
    const set = this.deck.data.settings || {};
    const draw = (variant) => (set.steps
      ? renderSteps(set.steps, s.map, { variant, style: set.stepStyle || 'bar' })
      : renderMap(set.archmap, s.map, { variant }));
    if ((set.steps || set.archmap) && s.map != null) {
      const slots = node.querySelectorAll('[data-archmap]');
      if (slots.length) slots.forEach((slot) => slot.replaceChildren(draw(slot.dataset.archmap || 'big')));
      else { node.classList.add('has-map'); node.prepend(el('div', { class: 'map-strip' }, draw('strip'))); }
    }
    node.querySelectorAll('[data-qr]').forEach((slot) => {
      const which = slot.dataset.qr;
      const draw = () => slot.replaceChildren(qrSvg(which === 'public' ? this.ctx.publicUrl : this.ctx.liveUrl()));
      draw();
      if (which !== 'public') { const f = () => draw(); addEventListener('live-code', f); this.cleanup.push(() => removeEventListener('live-code', f)); }
    });
    node.querySelectorAll('[data-diagram]').forEach((slot) => {
      const level = +slot.dataset.diagram;
      const fromLevel = prev && this.deck.slides[prev.slide]?.diagramLevel != null && prev.slide < i ? this.deck.slides[prev.slide].diagramLevel : level - 1;
      renderDiagram(slot, this.deck.data.diagram, { level, animateFrom: Math.min(fromLevel, level - 1), tags: slot.hasAttribute('data-tags') });
    });
    if (s.type === 'poll') this.poll = new PollView(node, s.poll, this.ctx);
    if (s.type === 'results') this.mountResults(node, s);
    if (s.type === 'demo') this.demo = new DemoPlayer(node.querySelector('.demo-root') || node, this.deck.data.demos[s.demo]);
    if (this.poll) this.cleanup.push(() => this.poll.destroy());
  }

  mountResults(node, s) {
    const [aId, bId] = s.compare;
    const a = this.deck.pollDef(aId), b = this.deck.pollDef(bId);
    const cols = node.querySelector('.results-root') || node;
    const left = new Bars(a.labels, { scale: true, title: 'Before', short: true });
    const right = new Bars(b.labels, { scale: true, title: 'After', short: true });
    const delta = el('div', { class: 'delta' }, [el('p', { class: 'label' }, 'Change'), el('p', { class: 'stat delta-val' }, '–')]);
    const offline = el('p', { class: 'live-unavailable', hidden: true }, 'Live results unavailable');
    if (this.ctx.staticVotes) offline.textContent = '';
    cols.append(el('div', { class: 'results-grid' }, [left.node, delta, right.node]), offline);
    left.reveal(true); right.reveal(true);
    const upd = () => {
      const d = left.avg != null && right.avg != null ? right.avg - left.avg : null;
      const v = delta.querySelector('.delta-val');
      v.textContent = d == null ? '–' : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`;
      v.classList.toggle('up', d != null && d > 0);
    };
    const hook = () => {
      if (this.ctx.staticVotes) {
        const sa = this.ctx.staticVotes[aId], sb = this.ctx.staticVotes[bId];
        if (sa) left.set(sa); if (sb) right.set(sb); upd();
        return;
      }
      const live = this.ctx.live();
      offline.hidden = !!(live && live.online);
      if (!live || !live.runId) return;
      this.cleanup.push(live.watchVotes(aId, a.labels.length, (c) => { if (c) { left.set(c); upd(); } }));
      this.cleanup.push(live.watchVotes(bId, b.labels.length, (c) => { if (c) { right.set(c); upd(); } }));
    };
    hook();
  }
}

// Horizontal bars with counts and percentages. Renders only numbers + labels from the deck.
export class Bars {
  constructor(labels, { scale = false, title = null, short = false } = {}) {
    if (short) labels = labels.map((l) => String(l).split(' ·')[0]);
    this.labels = labels; this.scale = scale; this.counts = labels.map(() => 0); this.avg = null;
    this.rows = labels.map((l) => {
      const fill = el('div', { class: 'bar-fill' });
      const n = el('span', { class: 'bar-n' }, '0');
      const pct = el('span', { class: 'bar-pct' }, '0%');
      const row = el('div', { class: 'bar-row' }, [el('div', { class: 'bar-label' }, l), el('div', { class: 'bar-track' }, fill), el('div', { class: 'bar-num' }, [n, pct])]);
      return { row, fill, n, pct };
    });
    this.total = el('span', { class: 'bars-total-n' }, '0');
    this.avgEl = el('p', { class: 'stat bars-avg' }, '–');
    this.node = el('div', { class: 'bars concealed' }, [
      title ? el('p', { class: 'bars-title' }, title) : null,
      el('div', { class: 'bars-rows' }, this.rows.map((r) => r.row)),
      el('div', { class: 'bars-foot' }, [
        el('p', { class: 'bars-total' }, [this.total, ' votes']),
        scale ? el('div', { class: 'bars-avg-wrap empty' }, [el('p', { class: 'label' }, 'avg'), this.avgEl]) : null,
      ]),
    ]);
  }
  set(counts) {
    this.counts = counts;
    const total = counts.reduce((a, b) => a + b, 0);
    const max = Math.max(1, ...counts);
    this.rows.forEach((r, i) => {
      r.fill.style.width = `${(counts[i] / max) * 100}%`;
      r.n.textContent = counts[i];
      r.pct.textContent = `${total ? Math.round((counts[i] / total) * 100) : 0}%`;
    });
    this.total.textContent = total;
    this.avg = total ? counts.reduce((a, c, i) => a + c * (i + 1), 0) / total : null;
    this.avgEl.textContent = this.avg == null ? '–' : `${this.avg.toFixed(1)}`;
    this.avgEl.parentElement?.classList.toggle('empty', this.avg == null);
  }
  reveal(on) { this.node.classList.toggle('concealed', !on); }
}

class PollView {
  constructor(node, poll, ctx) {
    this.ctx = ctx; this.poll = poll; this.unsub = null;
    const root = node.querySelector('.poll-root') || node;
    this.bars = new Bars(poll.labels, { scale: !!poll.scale });
    this.count = el('p', { class: 'stat poll-count' }, '0');
    this.waiting = el('div', { class: 'poll-waiting' }, [this.count, el('p', { class: 'title' }, 'votes so far')]);
    this.closed = el('p', { class: 'label poll-closed', hidden: true }, 'Voting closed');
    this.offline = el('p', { class: 'live-unavailable', hidden: true }, 'Live results unavailable');
    root.append(
      el('h1', { class: 'headline poll-q' }, poll.question),
      el('div', { class: 'poll-body' }, [this.waiting, this.bars.node]),
      el('div', { class: 'poll-status' }, [el('span', { class: 'poll-cta' }, 'Vote on your phone · omarcevi.dev/live'), this.closed, this.offline]),
    );
    this.attach();
    this.onLive = () => this.attach();
    addEventListener('live-status', this.onLive);
  }
  attach() {
    if (this.ctx.staticVotes) { // public read-only deck: final results of the real run, baked in
      const c = this.ctx.staticVotes[this.poll.id];
      if (c) { this.bars.set(c); this.count.textContent = c.reduce((a, b) => a + b, 0); }
      return;
    }
    const live = this.ctx.live();
    const ok = !!(live && live.online && live.runId);
    this.offline.hidden = ok;
    if (!live || !live.runId || this.unsub) return;
    this.unsub = live.watchVotes(this.poll.id, this.poll.labels.length, (c) => {
      if (!c) return;
      this.bars.set(c);
      this.count.textContent = c.reduce((a, b) => a + b, 0);
    });
    this.pollUnsub = live.fb.F.onSnapshot(live.ref(`talks/${live.talkId}/runs/${live.runId}/polls/${this.poll.id}`), (s) => {
      this.closed.hidden = s.data()?.open !== false;
    }, () => {});
  }
  setStep(step) {
    const on = step >= 1;
    this.bars.reveal(on);
    this.waiting.classList.toggle('gone', on);
  }
  destroy() { if (this.unsub) this.unsub(); if (this.pollUnsub) this.pollUnsub(); removeEventListener('live-status', this.onLive); }
}
