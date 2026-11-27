// Public read-only deck (published after the talk by `npm run publish-public`): arrow keys, no live features,
// polls show the final results of the real run as static bars. No speaker notes in this build.
import { Deck } from './deck.js';
import { SlideView } from './render.js';
import { el } from './util.js';

export async function startPublic({ deckUrl = 'deck.public.json' } = {}) {
  const data = await (await fetch(deckUrl, { cache: 'no-cache' })).json();
  const deck = new Deck(data);
  const W = 1920, H = 1080;
  const host = el('div', { class: 'slide-host' });
  const count = el('div', { class: 'status-label' });
  const stage = el('div', { class: 'stage', style: `width:${W}px;height:${H}px` }, [host, count]);
  const prevB = el('button', { class: 'pub-nav prev', type: 'button', 'aria-label': 'Previous slide' }, '‹');
  const nextB = el('button', { class: 'pub-nav next', type: 'button', 'aria-label': 'Next slide' }, '›');
  document.body.append(el('div', { class: 'viewport' }, stage), prevB, nextB);
  const fit = () => { stage.style.transform = `translate(-50%, -50%) scale(${Math.min(innerWidth / W, innerHeight / H)})`; };
  addEventListener('resize', fit); fit();
  const view = new SlideView(host, deck, { live: () => null, liveUrl: () => 'https://omarcevi.dev/live/', publicUrl: location.href.split('#')[0], staticVotes: data.results || {} });
  const m = location.hash.match(/^#(\d+)/);
  let pos = deck.clamp({ slide: m ? +m[1] - 1 : 0, step: 0 });
  const go = (p) => { pos = deck.clamp(p); view.show(pos); count.textContent = `${pos.slide + 1} / ${deck.count}`; history.replaceState(null, '', `#${pos.slide + 1}`); };
  // in the shared deck a poll slide opens already revealed
  const show = (p) => go(deck.slides[p.slide]?.type === 'poll' ? { ...p, step: deck.steps(p.slide) } : p);
  show(pos);
  addEventListener('keydown', (e) => {
    if (['ArrowRight', ' ', 'PageDown', 'ArrowDown'].includes(e.key)) { e.preventDefault(); show(deck.next(pos)); }
    if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(e.key)) { e.preventDefault(); show(deck.prev(pos)); }
    if (e.key === 'Home') show(deck.first());
    if (e.key === 'End') show(deck.last());
  });
  nextB.addEventListener('click', () => show(deck.next(pos)));
  prevB.addEventListener('click', () => show(deck.prev(pos)));
}
