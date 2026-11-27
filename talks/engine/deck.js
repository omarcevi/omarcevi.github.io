// Deck model: positions are { slide, step, ended }. A slide with N builds has steps 0..N.
export class Deck {
  constructor(data) {
    this.data = data;
    this.slides = data.slides;
    this.talkId = data.talkId;
  }
  get count() { return this.slides.length; }
  steps(i) { return this.slides[i]?.steps || 0; }
  clamp(pos) {
    const slide = Math.min(Math.max(0, pos.slide | 0), this.count - 1);
    const step = Math.min(Math.max(0, pos.step | 0), this.steps(slide));
    return { slide, step, ended: !!pos.ended && slide === this.count - 1 };
  }
  next(p) {
    if (p.ended) return p;
    if (p.step < this.steps(p.slide)) return { ...p, step: p.step + 1 };
    if (p.slide < this.count - 1) return { slide: p.slide + 1, step: 0, ended: false };
    return { ...p, ended: true }; // after the last slide: phones switch to the thank-you state
  }
  prev(p) {
    if (p.ended) return { ...p, ended: false };
    if (p.step > 0) return { ...p, step: p.step - 1 };
    if (p.slide > 0) return { slide: p.slide - 1, step: this.steps(p.slide - 1), ended: false };
    return p;
  }
  first() { return { slide: 0, step: 0, ended: false }; }
  last() { return { slide: this.count - 1, step: this.steps(this.count - 1), ended: false }; }
  pollIdAt(i) { return this.slides[i]?.type === 'poll' ? this.slides[i].poll.id : null; }
  pollDef(id) { return this.slides.find((s) => s.type === 'poll' && s.poll.id === id)?.poll || null; }

  // The only slide information phones ever receive: a short title, a type and an accent.
  runFields(p) {
    const s = this.slides[p.slide];
    const map = { poll: 'poll', qr: 'qr', results: 'results' };
    return {
      slide: p.slide,
      slideType: p.ended ? 'ended' : (map[s.type] || 'normal'),
      phoneTitle: p.ended ? '' : (s.phoneTitle || ''),
      pollId: !p.ended && s.type === 'poll' ? s.poll.id : null,
      accent: s.accent || 'none',
      step: typeof s.map === 'number' && s.map > 0 ? s.map : 0, // phones show the 5-step tiles
    };
  }
  same(a, b) { return a && b && a.slide === b.slide && a.step === b.step && !!a.ended === !!b.ended; }
}
