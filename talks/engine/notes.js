// Speaker notes view for the laptop: current notes, next slide, timer. Follows the projector
// in the same browser (BroadcastChannel) and, when signed in, the control doc (remote/projector anywhere).
import { unlockDeck } from './unlock.js';
import { Deck } from './deck.js';
import { el, fmtTime } from './util.js';

export async function startNotes({ talkId }) {
  const deck = new Deck(await unlockDeck(talkId, { title: 'Notes' }));
  const talkMs = (deck.data.settings?.talkMinutes || 38) * 60000;
  const cur = el('h1', { class: 'nt-cur' }), num = el('p', { class: 'nt-num' }), next = el('p', { class: 'nt-next' });
  const notes = el('div', { class: 'nt-notes' }), timer = el('button', { class: 'nt-timer', type: 'button' }, '0:00');
  document.body.append(el('div', { class: 'nt' }, [el('div', { class: 'nt-top' }, [num, timer]), cur, notes, next]));
  let start = 0;
  timer.addEventListener('click', () => { start = Date.now(); });
  setInterval(() => { timer.textContent = `${fmtTime(start ? Date.now() - start : 0)} / ${fmtTime(talkMs)}`; timer.classList.toggle('over', start && Date.now() - start > talkMs); }, 500);
  function show(p) {
    const s = deck.slides[p.slide], n = deck.slides[p.slide + 1];
    if (!start && p.slide > 0) start = Date.now();
    num.textContent = `${p.slide + 1} / ${deck.count}${deck.steps(p.slide) ? ` · step ${p.step}/${deck.steps(p.slide)}` : ''}${p.ended ? ' · ended' : ''}`;
    cur.textContent = s.title;
    notes.innerHTML = s.notes || '<p>—</p>';
    next.textContent = n ? `Next: ${n.title}` : 'Last slide';
  }
  show(deck.first());
  if ('BroadcastChannel' in window) new BroadcastChannel(`talk:${talkId}`).onmessage = (e) => { if (e.data?.type === 'pos') show(deck.clamp(e.data.pos)); };
  try {
    const { loadFirebase, waitForUser } = await import('./fb.js');
    const fb = await loadFirebase();
    const u = await waitForUser(fb);
    if (!u || u.isAnonymous) return;
    const { LiveSession } = await import('./presenter-live.js');
    const live = new LiveSession(fb, deck, 'notes');
    live.addEventListener('control', ({ detail }) => show(detail.pos));
    live.start();
  } catch { /* BroadcastChannel only */ }
}
