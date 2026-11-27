// Phone remote for the presenter: Prev/Next, notes, switches, panic button, live stats.
import { unlockDeck, presenterSignIn } from './unlock.js';
import { Deck } from './deck.js';
import { el, fmtTime } from './util.js';
import { loadFirebase } from './fb.js';
import { LiveSession } from './presenter-live.js';

export async function startRemote({ talkId }) {
  const deck = new Deck(await unlockDeck(talkId, { title: 'Remote' }));
  const talkMs = (deck.data.settings?.talkMinutes || 38) * 60000;
  let fb;
  try { fb = await loadFirebase(); } catch { document.body.append(el('p', { class: 'rm-error' }, 'Cannot reach Firebase. Use the clicker.')); return; }
  await presenterSignIn(fb, { title: 'Remote' });
  const live = new LiveSession(fb, deck, 'remote');
  window.__live = live;

  // ---------- DOM ----------
  const $ = {};
  const sw = (key, label) => {
    const b = el('button', { class: 'rm-switch', type: 'button', 'data-key': key, 'aria-pressed': 'false' }, [el('span', { class: 'rm-sw-dot' }), label]);
    $[`sw_${key}`] = b;
    return b;
  };
  $.num = el('span', { class: 'rm-num' }, '–');
  $.title = el('span', { class: 'rm-title' }, '');
  $.step = el('span', { class: 'rm-step' }, '');
  $.next = el('p', { class: 'rm-next' }, '');
  $.timer = el('button', { class: 'rm-timer', type: 'button', title: 'Tap to start / reset' }, '0:00 / 38:00');
  $.notes = el('div', { class: 'rm-notes-body' });
  $.offline = el('p', { class: 'rm-warn', hidden: true }, 'Projector offline');
  $.conn = el('p', { class: 'rm-warn', hidden: true }, 'Remote offline');
  $.stats = el('p', { class: 'rm-stats' }, '');
  $.stop = el('button', { class: 'rm-stop', type: 'button' }, 'Stop live');
  $.newRun = el('button', { class: 'rm-small', type: 'button' }, 'New run…');
  $.prev = el('button', { class: 'rm-nav prev', type: 'button', 'aria-label': 'Previous' }, 'Prev');
  $.nextBtn = el('button', { class: 'rm-nav next', type: 'button', 'aria-label': 'Next' }, 'Next');
  const top = el('div', { class: 'rm-top' }, [
    el('div', { class: 'rm-row' }, [$.num, $.step, $.timer]),
    el('p', { class: 'rm-cur' }, $.title),
    $.next, $.offline, $.conn,
    el('details', { class: 'rm-notes' }, [el('summary', {}, 'Notes'), $.notes]),
    el('div', { class: 'rm-switches' }, [sw('liveEnabled', 'Live'), sw('reactionsEnabled', 'Reactions'), sw('pollsEnabled', 'Polls'), sw('cornerQr', 'Corner QR'), sw('blank', 'Blank')]),
    $.stats,
    el('div', { class: 'rm-row' }, [$.stop, $.newRun]),
  ]);
  document.body.append(el('div', { class: 'rm' }, [top, el('div', { class: 'rm-navs' }, [$.prev, $.nextBtn])]));

  // ---------- state ----------
  let pos = null; let votes = null; let unsubVotes = null; let unsubBeat = null; let beat = null; let beatSeen = 0;
  const go = (p) => {
    if (!pos) return;
    pos = deck.clamp(p); pos.ended = !!p.ended && pos.slide === deck.count - 1;
    live.navigate(pos); paint();
    if (!timerStart && pos.slide > 0) startTimer();
  };
  $.nextBtn.addEventListener('click', () => { navigator.vibrate?.(8); go(deck.next(pos)); });
  $.prev.addEventListener('click', () => { navigator.vibrate?.(8); go(deck.prev(pos)); });
  $.stop.addEventListener('click', () => { navigator.vibrate?.([20, 40, 20]); live.stopLive(); });
  $.newRun.addEventListener('click', () => {
    if (confirm('Start a new run? Votes, reactions and joins start from zero.')) live.newRun(pos || deck.first());
  });
  for (const key of ['liveEnabled', 'reactionsEnabled', 'pollsEnabled']) {
    $[`sw_${key}`].addEventListener('click', () => live.setSwitch(key, !(live.run?.[key])));
  }
  $.sw_cornerQr.addEventListener('click', () => live.setControl('cornerQr', live.control?.cornerQr === false));
  $.sw_blank.addEventListener('click', () => live.setControl('blank', !live.control?.blank));

  // talk timer (local to this phone)
  let timerStart = +(localStorage.getItem(`remote:timer:${talkId}`) || 0) || 0;
  function startTimer() { timerStart = Date.now(); try { localStorage.setItem(`remote:timer:${talkId}`, String(timerStart)); } catch { /* */ } }
  $.timer.addEventListener('click', () => { if (!timerStart || confirm('Reset the timer?')) startTimer(); });
  setInterval(() => {
    const ms = timerStart ? Date.now() - timerStart : 0;
    $.timer.textContent = `${fmtTime(ms)} / ${fmtTime(talkMs)}`;
    $.timer.classList.toggle('over', ms > talkMs);
    $.offline.hidden = !live.runId || (Date.now() - beatSeen < 75000) // background tabs fire timers ~1/min;
  }, 500);

  function paint() {
    if (!pos) return;
    const s = deck.slides[pos.slide];
    const n = deck.slides[pos.slide + 1];
    $.num.textContent = `${pos.slide + 1}/${deck.count}${pos.ended ? ' · ended' : ''}`;
    $.title.textContent = s.title || s.phoneTitle || s.id;
    $.step.textContent = deck.steps(pos.slide) ? `step ${pos.step}/${deck.steps(pos.slide)}` : '';
    $.next.textContent = n ? `Next: ${n.title || n.phoneTitle || n.id}` : 'Next: (end → phones show thank-you)';
    if ($.notes.dataset.slide !== String(pos.slide)) { $.notes.innerHTML = s.notes || '<p>—</p>'; $.notes.dataset.slide = String(pos.slide); }
    const pid = deck.pollIdAt(pos.slide);
    if (pid !== $.stats.dataset.poll) {
      if (unsubVotes) unsubVotes();
      votes = null; $.stats.dataset.poll = pid || '';
      unsubVotes = pid ? live.watchVotes(pid, deck.pollDef(pid).labels.length, (c) => { votes = c ? c.reduce((a, b) => a + b, 0) : null; paintStats(); }) : null;
    }
    paintStats();
  }
  function paintSwitches() {
    const r = live.run || {}, c = live.control || {};
    const st = { liveEnabled: !!r.liveEnabled, reactionsEnabled: !!r.reactionsEnabled, pollsEnabled: !!r.pollsEnabled, cornerQr: c.cornerQr !== false, blank: !!c.blank };
    for (const [k, v] of Object.entries(st)) { $[`sw_${k}`].setAttribute('aria-pressed', String(v)); $[`sw_${k}`].classList.toggle('on', v); }
  }
  function paintStats() {
    const parts = [`${beat?.joined ?? 0} joined`, `${beat?.r30 ?? 0} reactions / 30 s`];
    if (votes != null) parts.push(`${votes} votes`);
    $.stats.textContent = parts.join(' · ');
  }

  live.addEventListener('control', ({ detail }) => {
    if (!pos || detail.foreign || detail.first) { pos = detail.pos; paint(); }
    paintSwitches();
  });
  live.addEventListener('run', paintSwitches);
  live.addEventListener('status', () => { $.conn.hidden = live.online; });
  live.addEventListener('runchange', () => {
    if (unsubBeat) unsubBeat();
    $.stats.dataset.poll = '__';
    let firstBeat = true;
    unsubBeat = live.watchHeartbeat((b, fromCache) => {
      beat = b;
      if (b && !fromCache) {
        // first read may be an old heartbeat: trust its server time; later changes arrive live
        beatSeen = firstBeat ? Math.min(Date.now(), b.at?.toMillis?.() || 0) : Date.now();
        firstBeat = false;
      }
      paintStats();
    });
  });
  live.start();

  // keep the screen awake on stage
  let lock = null;
  const wake = async () => { try { lock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ } };
  wake();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (!lock || lock.released)) wake(); });
}
