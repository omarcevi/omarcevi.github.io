// Floating reactions on the projector. Renders ONLY characters from the fixed map in config.js.
// Throttles on top of the rules: per uid 1 / 1.5 s and ~20 per slide, max ~25 on screen,
// bursts collapse into "👏 ×12" bubbles. Emoji keys not in `float` still count, but never float.
import { REACTION_BY_KEY, REACTION_COOLDOWN_MS } from './config.js';
import { el } from './util.js';

const MAX_VISIBLE = 25;
const PER_SLIDE = 20;
const BURST_WINDOW = 1500;
const BURST_SINGLES = 4; // per emoji per window before collapsing into a bubble

export class ReactionLayer {
  constructor(host, { float = ['clap', 'fire', 'mindblown', 'laugh', 'think'] } = {}) {
    this.host = host; this.float = new Set(float);
    this.lastByUid = new Map(); this.perSlide = new Map();
    this.visible = 0; this.recent = []; this.window = new Map(); this.bubbles = new Map();
    this.enabled = true; this.counts = {};
  }
  setEnabled(on) { this.enabled = on; if (!on) this.host.replaceChildren(), this.visible = 0, this.bubbles.clear(); }

  // r: raw reaction doc { emoji, slide, uid, at }. Anything malformed is dropped silently.
  push(r, currentSlide) {
    const def = REACTION_BY_KEY[r?.emoji];
    if (!def || typeof r.uid !== 'string' || !Number.isInteger(r.slide)) return false;
    const now = performance.now();
    const last = this.lastByUid.get(r.uid) || -Infinity;
    if (now - last < REACTION_COOLDOWN_MS - 100) return false;
    this.lastByUid.set(r.uid, now);
    const k = `${r.uid}|${currentSlide}`;
    const n = (this.perSlide.get(k) || 0) + 1;
    this.perSlide.set(k, n);
    if (n > PER_SLIDE) return false;
    this.recent.push(now);
    this.counts[r.emoji] = (this.counts[r.emoji] || 0) + 1;
    if (!this.enabled || !this.float.has(r.emoji) || document.hidden) return true;

    const w = (this.window.get(r.emoji) || []).filter((t) => now - t < BURST_WINDOW);
    w.push(now); this.window.set(r.emoji, w);
    if (w.length > BURST_SINGLES || this.visible >= MAX_VISIBLE) this.bump(def);
    else this.spawn(def.emoji, 'r-single');
    return true;
  }

  recentCount(ms = 30000) {
    const now = performance.now();
    this.recent = this.recent.filter((t) => now - t < ms);
    return this.recent.length;
  }

  spawn(text, cls) {
    const x = 6 + Math.random() * 88;
    const drift = (Math.random() * 2 - 1) * 60;
    const n = el('div', { class: `reaction ${cls}`, style: `left:${x}%;--drift:${drift}px` }, text);
    n.addEventListener('animationend', () => { n.remove(); this.visible--; });
    this.visible++;
    this.host.append(n);
    return n;
  }

  bump(def) {
    let b = this.bubbles.get(def.key);
    if (b && b.n.isConnected && performance.now() - b.t < 1800) {
      b.count++; b.label.textContent = `×${b.count}`;
      b.n.classList.remove('pulse'); void b.n.offsetWidth; b.n.classList.add('pulse');
      return;
    }
    if (this.visible >= MAX_VISIBLE + 4) return;
    const label = el('span', { class: 'r-count' }, '×1');
    const n = this.spawn('', 'r-bubble');
    n.append(el('span', {}, def.emoji), label);
    b = { n, label, count: 1, t: performance.now() };
    this.bubbles.set(def.key, b);
  }
}
