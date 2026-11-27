// Audience phone page. Loads NO slide content: it only knows what the run doc says right now
// (phoneTitle, slideType, switches) and, on poll slides, the active poll's question and labels.
// Phones write only ints, fixed emoji keys, timestamps and their uid. They never see results.
import { REACTIONS, REACTION_COOLDOWN_MS } from './config.js';
import { el } from './util.js';
import { loadFirebase, paths } from './fb.js';

const TR = (navigator.language || '').toLowerCase().startsWith('tr');
const T = TR ? {
  soon: 'Konuşma birazdan başlıyor', scan: 'Ekrandaki QR kodu okutun.', scanSub: 'Katılmak için kamerayı ekrandaki koda tutun.',
  voted: '✓ Oyun alındı — sonuçlar ekranda!', change: 'Oyunu değiştirebilirsin.', closed: 'Oylama kapandı', paused: 'Canlı etkileşim şu an kapalı',
  reconnecting: 'yeniden bağlanıyor…', thanks: 'Teşekkürler!', thanksSub: 'Katıldığın için teşekkürler.', deck: 'Sunumu aç', linkedin: 'LinkedIn’de bağlan',
  react: 'Tepki gönder', poll: 'Anket', waitPoll: 'Anket yükleniyor…', loading: 'Bağlanıyor…', reactionsOff: 'Tepkiler şu an kapalı', pollsOff: 'Oylama şu an kapalı',
  qrSlide: 'Hoş geldin! Bir 👏 gönder.', results: 'Sonuçlar ekranda', deckSoon: 'Slaytlar konuşmadan sonra paylaşılacak.',
} : {
  soon: 'The talk will start soon', scan: 'Scan the QR code on the screen.', scanSub: 'Point your camera at the code on the big screen to join.',
  voted: '✓ Vote received — results are on the screen!', change: 'You can change your vote.', closed: 'Voting closed', paused: 'Live interaction is paused',
  reconnecting: 'reconnecting…', thanks: 'Thank you!', thanksSub: 'Thanks for playing along.', deck: 'Open the slides', linkedin: 'Connect on LinkedIn',
  react: 'Send a reaction', poll: 'Poll', waitPoll: 'Loading poll…', loading: 'Connecting…', reactionsOff: 'Reactions are paused', pollsOff: 'Voting is paused',
  qrSlide: 'Welcome! Send a 👏 to test it.', results: 'Results are on the screen', deckSoon: 'Slides will be shared after the talk.',
};
document.documentElement.lang = TR ? 'tr' : 'en';

export async function startPhone({ talkId, talkTitle, footer, publicUrl, linkedin }) {
  const app = document.getElementById('app');
  const pill = el('div', { class: 'pill', hidden: true }, T.reconnecting);
  const main = el('main', { class: 'ph-main' });
  app.replaceChildren(pill, main, el('footer', { class: 'ph-foot' }, footer));
  const show = (...kids) => main.replaceChildren(...kids.filter(Boolean));
  show(el('p', { class: 'ph-muted' }, T.loading));

  // ---------- join code (from the QR: /live/?k=CODE) ----------
  const q = new URLSearchParams(location.search);
  const codeKey = `live:k:${talkId}`;
  let code = (q.get('k') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || null;
  try { if (code) localStorage.setItem(codeKey, code); else code = localStorage.getItem(codeKey); } catch { /* ignore */ }
  if (q.has('k')) history.replaceState(null, '', location.pathname); // keep the code out of shared links

  let fb;
  try { fb = await loadFirebase(); } catch { pill.hidden = false; setTimeout(() => location.reload(), 8000); return; }
  const { A, F, db, auth } = fb;
  // Reuse an existing login (e.g. the presenter's Google login from /remote/ in the same browser):
  // signing in anonymously would replace it and silently sign the remote out.
  const existing = await new Promise((res) => { const off = A.onAuthStateChanged(auth, (u) => { off(); res(u); }); });
  const user = existing || (await A.signInAnonymously(auth).catch(() => null))?.user;
  if (!user) { pill.hidden = false; setTimeout(() => location.reload(), 8000); return; }
  const uid = user.uid;
  // If another tab changes the login (e.g. /remote/ sign-in in the same browser), start over with that user.
  A.onAuthStateChanged(auth, (u) => { if (u && u.uid !== uid) location.reload(); });

  let runId = null, run = null, joined = false, joinFailed = false, unsubRun = null, unsubPoll = null;
  let poll = null, myVote = null, failures = 0, n = null;
  let renderKey = '';

  const setOnline = (on) => { pill.hidden = on && navigator.onLine !== false; };
  addEventListener('offline', () => setOnline(false));
  addEventListener('online', () => setOnline(true));

  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 3000) F.disableNetwork(db).then(() => F.enableNetwork(db)).catch(() => {});
    hiddenAt = 0;
  });
  F.onSnapshot(F.doc(db, paths.talk(talkId)), { includeMetadataChanges: true }, (s) => {
    setOnline(!s.metadata.fromCache);
    const r = s.data()?.activeRunId || null;
    if (r !== runId) attachRun(r);
    else if (!r) render();
  }, () => setOnline(false));

  function attachRun(r) {
    if (unsubRun) unsubRun();
    if (unsubPoll) { unsubPoll(); unsubPoll = null; }
    runId = r; run = null; joined = false; joinFailed = false; poll = null; myVote = null; n = null; failures = 0;
    if (!r) { render(); return; }
    try { joined = localStorage.getItem(`live:joined:${talkId}:${r}:${uid}`) === '1'; } catch { /* ignore */ }
    unsubRun = F.onSnapshot(F.doc(db, paths.run(talkId, r)), { includeMetadataChanges: true }, (s) => {
      setOnline(!s.metadata.fromCache);
      const prevPoll = run?.pollId;
      run = s.data() || null;
      if (run?.pollId !== prevPoll) watchPoll(run?.pollId || null);
      render();
    }, () => setOnline(false));
    join();
  }

  async function join() {
    if (joined || !code || !runId) { render(); return; }
    try {
      await F.setDoc(F.doc(db, paths.joined(talkId, runId, uid)), { at: F.serverTimestamp(), code });
      joined = true;
    } catch (e) {
      // already joined (create-only) → fine; wrong/old code → ask to scan again
      const exists = await F.getDoc(F.doc(db, paths.joined(talkId, runId, uid))).then((s) => s.exists()).catch(() => false);
      if (exists) joined = true;
      else if (e.code === 'permission-denied') { joinFailed = true; try { localStorage.removeItem(codeKey); } catch { /* */ } code = null; }
    }
    if (joined) try { localStorage.setItem(`live:joined:${talkId}:${runId}:${uid}`, '1'); } catch { /* ignore */ }
    render();
  }

  function watchPoll(pollId) {
    if (unsubPoll) { unsubPoll(); unsubPoll = null; }
    poll = null; myVote = null;
    if (!pollId) return;
    try { const v = localStorage.getItem(`live:vote:${runId}:${pollId}:${uid}`); myVote = v == null ? null : +v; } catch { /* ignore */ }
    // draw the options straight from the run doc; the poll doc only adds open/closed
    if (run?.poll?.question) poll = { id: pollId, question: run.poll.question, labels: run.poll.labels, open: true };
    unsubPoll = F.onSnapshot(F.doc(db, paths.poll(talkId, runId, pollId)), (s) => {
      if (!s.exists() && s.metadata.fromCache && poll) return; // cache miss: keep the options from the run doc
      poll = s.exists() ? { id: pollId, ...s.data() } : null; render(true);
    }, () => {});
  }

  // ---------- rendering ----------
  function header() {
    // phoneTitle is "Türkçe / English": show the half that matches the phone's language
    const parts = String(run?.phoneTitle || '').split(' / ');
    const title = (TR ? parts[0] : parts[1] || parts[0]) || '';
    const step = Number.isInteger(run?.step) ? run.step : 0;
    return el('div', { class: 'ph-head' }, [
      el('div', { class: 'ph-top' }, [
        el('p', { class: 'ph-eyebrow' }, 'AI ENGINEERING · 5 STEPS'),
        el('div', { class: 'ph-steps', 'aria-label': step ? `Step ${step} of 5` : '' }, [1, 2, 3, 4, 5].map((k) => el('b', { class: k === step ? 'now' : k < step ? 'done' : '' }, String(k)))),
      ]),
      el('h1', { class: 'ph-title' }, title),
    ]);
  }

  function render(force = false) {
    const key = JSON.stringify([runId, run?.slide, run?.accent, run?.step, run?.slideType, run?.pollId, run?.liveEnabled, run?.reactionsEnabled, run?.pollsEnabled, joined, joinFailed, !!code, poll?.open, poll?.question, myVote, failures >= 3]);
    if (key === renderKey && !force) return;
    renderKey = key;
    const accent = ['blue', 'red', 'yellow', 'green'].includes(run?.accent) && run?.slideType !== 'ended' ? run.accent : 'none';
    document.body.dataset.accent = accent;
    if (!runId || !run) return show(el('div', { class: 'ph-center' }, [el('p', { class: 'ph-eyebrow' }, talkTitle), el('h1', { class: 'ph-title' }, T.soon)]));
    if (run.slideType === 'ended') return show(ended());
    if (!code && !joined) return show(el('div', { class: 'ph-center' }, [el('div', { class: 'ph-qr-icon', 'aria-hidden': 'true' }), el('h1', { class: 'ph-title' }, T.scan), el('p', { class: 'ph-muted' }, T.scanSub)]));
    if (!run.liveEnabled) return show(header(), el('p', { class: 'ph-state' }, T.paused));
    if (run.slideType === 'poll') return show(header(), pollView());
    if (run.slideType === 'results') return show(header(), el('p', { class: 'ph-state' }, T.results), reactionsView());
    return show(header(), run.slideType === 'qr' ? el('p', { class: 'ph-muted' }, T.qrSlide) : null, reactionsView());
  }

  function ended() {
    return el('div', { class: 'ph-center' }, [
      el('p', { class: 'ph-eyebrow' }, talkTitle),
      el('h1', { class: 'ph-title big' }, T.thanks),
      el('p', { class: 'ph-muted' }, T.thanksSub),
      el('a', { class: 'ph-btn', href: publicUrl }, T.deck),
      el('a', { class: 'ph-btn ghost', href: `https://${linkedin}`, rel: 'noopener' }, T.linkedin),
    ]);
  }

  function pollView() {
    if (!run.pollsEnabled) return el('p', { class: 'ph-state' }, T.pollsOff);
    if (!poll) return el('p', { class: 'ph-muted' }, T.waitPoll);
    if (!poll.open) return el('p', { class: 'ph-state' }, T.closed);
    const labels = Array.isArray(poll.labels) ? poll.labels.slice(0, 8) : [];
    const disabled = failures >= 3;
    return el('div', { class: 'ph-poll' }, [
      el('h2', { class: 'ph-q' }, String(poll.question || '')),
      el('div', { class: 'ph-options' }, labels.map((l, i) => {
        const rest = String(l).replace(new RegExp(`^${i + 1}\\s*·?\\s*`), '');
        const b = el('button', { class: `ph-opt${myVote === i ? ' chosen' : ''}`, type: 'button', disabled }, [el('b', {}, String(i + 1)), el('span', {}, poll.labels.every((x, k) => String(x).startsWith(String(k + 1))) ? rest : String(l))]);
        b.addEventListener('click', () => vote(i, b));
        return b;
      })),
      myVote != null ? el('p', { class: 'ph-ok' }, [T.voted, el('br'), el('span', { class: 'ph-muted small' }, T.change)]) : null,
    ]);
  }

  let lastVoteAt = 0;
  async function vote(i, btn) {
    if (Date.now() - lastVoteAt < 1100 || myVote === i) return;
    lastVoteAt = Date.now();
    navigator.vibrate?.(10);
    btn.classList.add('pop');
    const prev = myVote; myVote = i; render(true);
    try {
      await F.setDoc(F.doc(db, paths.vote(talkId, runId, poll.id, uid)), { value: i, at: F.serverTimestamp() });
      failures = 0;
      try { localStorage.setItem(`live:vote:${runId}:${poll.id}:${uid}`, String(i)); } catch { /* ignore */ }
    } catch { myVote = prev; failures++; }
    render(true);
  }

  function reactionsView() {
    if (!run.reactionsEnabled) return el('p', { class: 'ph-state' }, T.reactionsOff);
    const disabled = failures >= 3;
    return el('div', { class: 'ph-react' }, [
      el('p', { class: 'ph-label' }, T.react),
      el('div', { class: 'ph-grid a1' }, REACTIONS.map((r) => {
        const b = el('button', { class: 'ph-rx', type: 'button', 'data-key': r.key, disabled, 'aria-label': TR ? r.tr : r.en }, [
          el('span', { class: 'ph-emoji', 'aria-hidden': 'true' }, r.emoji), el('span', { class: 'ph-rx-label' }, TR ? r.tr : r.en), el('span', { class: 'ring', 'aria-hidden': 'true' }),
        ]);
        b.addEventListener('click', () => react(r.key, b));
        return b;
      })),
    ]);
  }

  let lastRx = 0;
  async function react(key, btn) {
    const now = Date.now();
    if (now - lastRx < REACTION_COOLDOWN_MS) return;
    lastRx = now;
    navigator.vibrate?.(10);
    main.querySelectorAll('.ph-rx').forEach((b) => { b.classList.remove('cooling'); void b.offsetWidth; b.classList.add('cooling'); });
    btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
    try {
      if (n == null) n = await currentN();
      const next = n + 1;
      const b = F.writeBatch(db);
      b.set(F.doc(db, paths.lastReaction(talkId, runId, uid)), { at: F.serverTimestamp(), n: next });
      b.set(F.doc(db, paths.reaction(talkId, runId, `${uid}_${next}`)), { emoji: key, slide: run.slide | 0, uid, at: F.serverTimestamp() });
      await b.commit();
      n = next; failures = 0;
    } catch {
      n = null; failures++;
      if (failures >= 3) { render(true); setTimeout(() => { failures = 0; render(true); }, 15000); }
    }
  }
  async function currentN() {
    const s = await F.getDoc(F.doc(db, paths.lastReaction(talkId, runId, uid)));
    return s.exists() ? (s.data().n | 0) : 0;
  }
}
