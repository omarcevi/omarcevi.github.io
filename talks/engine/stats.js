// Presenter-only stats: reactions per slide and poll results per run.
import { unlockDeck, presenterSignIn } from './unlock.js';
import { Deck } from './deck.js';
import { el } from './util.js';
import { loadFirebase, paths } from './fb.js';
import { REACTIONS, REACTION_BY_KEY } from './config.js';

export async function startStats({ talkId }) {
  const deck = new Deck(await unlockDeck(talkId, { title: 'Stats' }));
  const fb = await loadFirebase();
  await presenterSignIn(fb, { title: 'Stats' });
  const { F, db } = fb;
  const pick = el('select', { class: 'st-pick', 'aria-label': 'Run' });
  const out = el('div', { class: 'st-out' });
  document.body.append(el('div', { class: 'nt' }, [el('h1', { class: 'nt-cur' }, 'Stats'), pick, out]));
  const talk = (await F.getDoc(F.doc(db, paths.talk(talkId)))).data() || {};
  const runs = await F.getDocs(F.collection(db, `talks/${talkId}/runs`));
  const ids = runs.docs.map((d) => d.id).sort().reverse();
  ids.forEach((id) => pick.append(el('option', { value: id, selected: id === talk.activeRunId }, `${id}${id === talk.activeRunId ? ' (active)' : ''}`)));
  pick.addEventListener('change', () => show(pick.value));
  if (ids.length) show(talk.activeRunId || ids[0]);

  async function show(runId) {
    out.replaceChildren(el('p', {}, 'Loading…'));
    const [rx, joined] = await Promise.all([
      F.getDocs(F.collection(db, paths.reactions(talkId, runId))),
      F.getDocs(F.collection(db, paths.joinedCol(talkId, runId))),
    ]);
    const per = {};
    rx.forEach((d) => { const r = d.data(); if (!REACTION_BY_KEY[r.emoji] || !Number.isInteger(r.slide)) return; (per[r.slide] ||= {})[r.emoji] = (per[r.slide]?.[r.emoji] || 0) + 1; });
    const table = el('table', { class: 'st-table' }, [
      el('tr', {}, [el('th', {}, '#'), el('th', {}, 'Slide'), ...REACTIONS.map((r) => el('th', {}, r.emoji)), el('th', {}, 'Σ')]),
      ...deck.slides.map((s, i) => {
        const c = per[i] || {};
        const sum = Object.values(c).reduce((a, b) => a + b, 0);
        return el('tr', {}, [el('td', {}, i + 1), el('td', {}, s.title), ...REACTIONS.map((r) => el('td', {}, c[r.key] || '')), el('td', {}, sum || '')]);
      }),
    ]);
    const polls = [];
    for (const s of deck.slides.filter((x) => x.type === 'poll')) {
      const vs = await F.getDocs(F.collection(db, paths.votes(talkId, runId, s.poll.id)));
      const counts = s.poll.labels.map(() => 0);
      vs.forEach((d) => { const v = d.data().value; if (Number.isInteger(v) && v >= 0 && v < counts.length) counts[v]++; });
      const total = counts.reduce((a, b) => a + b, 0);
      const avg = s.poll.scale && total ? (counts.reduce((a, c, i) => a + c * (i + 1), 0) / total).toFixed(2) : null;
      polls.push(el('div', { class: 'st-poll' }, [
        el('h2', {}, s.poll.question),
        el('p', {}, `${total} votes${avg ? ` · avg ${avg}` : ''}`),
        el('ul', {}, s.poll.labels.map((l, i) => el('li', {}, `${l}: ${counts[i]} (${total ? Math.round((counts[i] / total) * 100) : 0}%)`))),
      ]));
    }
    out.replaceChildren(el('p', {}, `${joined.size} joined · ${rx.size} reactions`), ...polls, el('h2', {}, 'Reactions per slide'), table);
  }
}
