// Projector view. Slides are local (decrypted deck in memory); Firebase only adds the live layer.
import { unlockDeck, presenterSignIn } from './unlock.js';
import { Deck } from './deck.js';
import { SlideView } from './render.js';
import { ReactionLayer } from './reactions.js';
import { el, qrSvg } from './util.js';
import { SITE, SHORT_LIVE } from './config.js';

const W = 1920, H = 1080;

export async function startProjector({ talkId }) {
  const deck = new Deck(await unlockDeck(talkId, { title: 'Projector' }));
  const settings = deck.data.settings || {};
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel(`talk:${talkId}`) : null;

  // ---------- DOM ----------
  const host = el('div', { class: 'slide-host' });
  const rxHost = el('div', { class: 'reactions', 'aria-hidden': 'true' });
  const cornerQr = el('div', { class: 'corner-qr' });
  const joinedEl = el('span', { class: 'corner-joined' }, '0 joined');
  const dot = el('span', { class: 'live-dot', title: 'live' });
  const corner = el('div', { class: 'corner', hidden: true }, [el('div', { class: 'corner-text' }, [dot, el('span', { class: 'corner-url' }, SHORT_LIVE), joinedEl])]);
  const status = el('div', { class: 'status-label' });
  const qrBig = el('div', { class: 'qr-big' });
  const qrOverlay = el('div', { class: 'overlay qr-overlay', hidden: true }, [qrBig, el('p', { class: 'qr-url' }, SHORT_LIVE), el('p', { class: 'qr-sub' }, 'Vote, react, follow along.')]);
  const blank = el('div', { class: 'overlay blank', hidden: true });
  const help = el('div', { class: 'overlay help', hidden: true }, helpContent());
  const stage = el('div', { class: 'stage', style: `width:${W}px;height:${H}px` }, [host, rxHost, corner, status, qrOverlay, blank, help]);
  const viewport = el('div', { class: 'viewport' }, stage);
  document.body.append(viewport);
  const fit = () => {
    const s = Math.min(innerWidth / W, innerHeight / H);
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  };
  addEventListener('resize', fit); fit();

  // ---------- state ----------
  let live = null; let code = null;
  const liveUrl = () => `${SITE}/live/${code ? `?k=${code}` : ''}`;
  const view = new SlideView(host, deck, {
    live: () => live,
    liveUrl,
    publicUrl: settings.publicUrl || `${SITE}/talks/${talkId}/`,
  });
  const rx = new ReactionLayer(rxHost, { float: settings.floatReactions });
  const hashPos = parseHash();
  let pos = deck.clamp(hashPos || deck.first());

  function render(p, { write = true } = {}) {
    pos = deck.clamp(p);
    pos.ended = !!p.ended && pos.slide === deck.count - 1;
    view.show(pos);
    history.replaceState(null, '', `#${pos.slide + 1}${pos.step ? `.${pos.step}` : ''}`);
    stage.classList.toggle('ended', pos.ended);
    updateOverlay();
    if (bc) bc.postMessage({ type: 'pos', pos });
    if (write && live) live.navigate(pos);
  }

  function updateOverlay() {
    const run = live?.run;
    const s = deck.slides[pos.slide];
    const liveOn = !!(live && run && run.liveEnabled);
    corner.hidden = !liveOn || s.type === 'qr' || s.type === 'poll' || live.control?.cornerQr === false;
    rx.setEnabled(liveOn && !!run.reactionsEnabled);
    dot.classList.toggle('on', !!live?.online);
    status.textContent = !live ? 'local only · not syncing' : (live.online ? '' : 'live off');
    status.hidden = !status.textContent;
  }

  function drawQr() {
    cornerQr.replaceChildren(qrSvg(liveUrl()));
    qrBig.replaceChildren(qrSvg(liveUrl()));
    dispatchEvent(new Event('live-code'));
  }
  drawQr();
  render(pos, { write: false });

  // ---------- keys ----------
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, .gate')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (['ArrowRight', ' ', 'PageDown', 'ArrowDown'].includes(k)) { e.preventDefault(); render(deck.next(pos)); }
    else if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(k)) { e.preventDefault(); render(deck.prev(pos)); }
    else if (k === 'Home') render(deck.first());
    else if (k === 'End') render(deck.last());
    else if (k === 'f' || k === 'F') { if (!e.shiftKey) toggleFullscreen(); }
    else if (k === 'q' || k === 'Q') { qrOverlay.hidden = !qrOverlay.hidden; }
    else if (k === 'b' || k === 'B') { setBlank(blank.hidden); if (live) live.setControl('blank', !blank.hidden); }
    else if (k === '?') help.hidden = !help.hidden;
    else if (k === 'Escape') { help.hidden = true; qrOverlay.hidden = true; }
    else if ((k === 'r' || k === 'R') && deck.slides[pos.slide].type === 'poll' && pos.step < 1) render({ ...pos, step: 1 });
    else if ((k === 'p' || k === 'P') && live) togglePoll();
    else if (k === 'N' && e.shiftKey && live) {
      if (confirm('Start a new run?\n\nVotes, reactions and joins start from zero. Phones must scan the new QR code.')) {
        live.newRun(pos).catch((err) => alert(`New run failed: ${err.code || err}`));
      }
    }
  });
  function setBlank(on) { blank.hidden = !on; }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
  }
  async function togglePoll() {
    const pid = deck.pollIdAt(pos.slide);
    if (!pid || !live.runId) return;
    const { F } = live.fb;
    const snap = await F.getDoc(live.ref(`talks/${talkId}/runs/${live.runId}/polls/${pid}`)).catch(() => null);
    live.setPollOpen(pid, !(snap?.data()?.open));
  }

  // ---------- live layer (never blocks the slides) ----------
  let fb;
  try {
    const { loadFirebase } = await import('./fb.js');
    fb = await loadFirebase();
  } catch (e) {
    console.warn('[live] firebase unavailable', e);
    updateOverlay();
    return;
  }
  const user = await presenterSignIn(fb, { allowSkip: true, title: 'Projector' });
  if (!user) { updateOverlay(); return; }
  const { LiveSession } = await import('./presenter-live.js');
  live = new LiveSession(fb, deck, 'projector');
  window.__live = live; // debugging + Playwright
  live.pending = pos;
  let unsubs = [];
  let beatTimer = null;
  live.addEventListener('runchange', () => {
    unsubs.forEach((u) => u()); unsubs = [];
    code = null; drawQr();
    unsubs.push(live.watchJoined((n) => {
      joinedEl.textContent = `${n} joined`;
      window.__joined = n;
      dispatchEvent(new CustomEvent('live-joined', { detail: n }));
    }));
    unsubs.push(live.watchReactions((r) => rx.push(r, pos.slide)));
    clearInterval(beatTimer);
    const beat = () => live.beat({ joined: live.joined, r30: rx.recentCount(30000), slide: pos.slide, counts: rx.counts });
    beatTimer = setInterval(beat, 10000); beat();
    view.cur = null; view.show(pos); // re-attach poll/results listeners for the new run
    dispatchEvent(new Event('live-status'));
  });
  live.addEventListener('control', ({ detail }) => {
    const c = detail.control;
    setBlank(!!c.blank);
    if (detail.first && !detail.foreign) { /* our own initial write */ }
    else if (detail.first && !hashPos) render(detail.pos, { write: false });
    else if (detail.first && hashPos) live.navigate(pos);
    else if (detail.foreign && !deck.same(detail.pos, pos)) render(detail.pos, { write: false });
    updateOverlay();
  });
  live.addEventListener('code', ({ detail }) => { code = detail; drawQr(); });
  live.addEventListener('run', updateOverlay);
  live.addEventListener('status', () => { updateOverlay(); dispatchEvent(new Event('live-status')); });
  live.start({ createIfMissing: true });
  updateOverlay();
}

function parseHash() {
  const m = location.hash.match(/^#(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  return { slide: +m[1] - 1, step: +(m[2] || 0) };
}

function helpContent() {
  const rows = [
    ['→  Space  PgDn  ↓', 'Next step / slide'], ['←  PgUp  ↑', 'Previous'], ['Home / End', 'First / last slide'],
    ['Q', 'Big QR overlay'], ['B', 'Blank screen'], ['P', 'Open / close poll'], ['R', 'Reveal poll results'],
    ['F', 'Fullscreen'], ['Shift+N', 'New run (confirm)'], ['?', 'This help'],
  ];
  return [el('p', { class: 'eyebrow' }, 'Keys'), el('dl', { class: 'help-grid' }, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]))];
}
