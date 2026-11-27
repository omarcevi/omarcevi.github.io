// Presenter-side live session, shared by the projector and the phone remote.
// Writes: control (slide/step, private), run doc (what phones see, only on slide change), poll docs.
import { paths } from './fb.js';
import { randomCode, newRunId } from './util.js';

export class LiveSession extends EventTarget {
  constructor(fb, deck, role) {
    super();
    this.fb = fb; this.deck = deck; this.role = role; this.talkId = deck.talkId;
    this.cid = `${role}-${Math.random().toString(36).slice(2, 8)}`;
    this.runId = null; this.run = null; this.control = null; this.code = null; this.heartbeat = null;
    this.joined = 0; this.online = false;
    this.lastWritten = null;   // last position written (for poll open/close transitions)
    this.pending = null;
    this.unsubs = []; this.runUnsubs = [];
    // leading edge: a lone press is written at once; a fast burst of presses becomes one trailing write
    this.flushSoon = () => {
      if (this.flushTimer) { this.flushQueued = true; return; }
      this.flush();
      this.flushTimer = setTimeout(() => { this.flushTimer = null; if (this.flushQueued) { this.flushQueued = false; this.flushSoon(); } }, 90);
    };
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  ref(p) { return this.fb.F.doc(this.fb.db, p); }

  start({ createIfMissing = false } = {}) {
    const { F } = this.fb;
    this.unsubs.push(F.onSnapshot(this.ref(paths.talk(this.talkId)), { includeMetadataChanges: true }, (snap) => {
      this.setOnline(!snap.metadata.fromCache);
      const runId = snap.data()?.activeRunId;
      if (!runId) {
        if (createIfMissing && !snap.metadata.fromCache && !this.creating) {
          this.creating = true;
          this.newRun(this.pending || this.deck.first()).finally(() => { this.creating = false; });
        }
        return;
      }
      if (runId !== this.runId) this.attach(runId);
    }, () => this.setOnline(false)));
    addEventListener('online', () => this.emit('status'));
    addEventListener('offline', () => this.setOnline(false));
  }

  setOnline(v) {
    const on = v && navigator.onLine !== false;
    if (on !== this.online) { this.online = on; this.emit('status'); }
  }

  attach(runId) {
    const { F } = this.fb;
    this.runUnsubs.forEach((u) => u()); this.runUnsubs = [];
    this.runId = runId; this.run = null; this.control = null; this.code = null; this.joined = 0; this.lastWritten = null;
    const t = this.talkId;
    this.runUnsubs.push(F.onSnapshot(this.ref(paths.run(t, runId)), { includeMetadataChanges: true }, (s) => {
      this.setOnline(!s.metadata.fromCache);
      this.run = s.data() || null;
      this.emit('run', this.run);
    }, () => this.setOnline(false)));
    this.runUnsubs.push(F.onSnapshot(this.ref(paths.control(t, runId)), (s) => {
      const c = s.data();
      if (!c) return;
      const first = this.control === null;
      this.control = c;
      const pos = this.deck.clamp({ slide: c.slide, step: c.step, ended: c.ended });
      const foreign = c.cid !== this.cid && !s.metadata.hasPendingWrites;
      if (foreign) this.lastWritten = pos;
      this.emit('control', { control: c, pos, foreign, first });
    }, () => {}));
    this.runUnsubs.push(F.onSnapshot(this.ref(paths.secret(t, runId)), (s) => {
      this.code = s.data()?.code || null;
      this.emit('code', this.code);
    }, () => {}));
    this.emit('runchange', runId);
  }

  // ---------------- navigation ----------------
  navigate(pos) {
    this.pending = pos;
    if (this.runId) this.flushSoon();
  }

  async flush() {
    const pos = this.pending;
    if (!pos || !this.runId) return;
    const { F, db } = this.fb;
    const t = this.talkId, r = this.runId;
    const b = F.writeBatch(db);
    b.set(this.ref(paths.control(t, r)), {
      slide: pos.slide, step: pos.step, ended: !!pos.ended, by: this.role, cid: this.cid, at: F.serverTimestamp(),
    }, { merge: true });
    const prev = this.lastWritten;
    if (!prev || prev.slide !== pos.slide || !!prev.ended !== !!pos.ended) {
      const pid = !pos.ended ? this.deck.pollIdAt(pos.slide) : null;
      const pd = pid ? this.deck.pollDef(pid) : null;
      b.set(this.ref(paths.run(t, r)), {
        ...this.deck.runFields(pos), by: this.role, updatedAt: F.serverTimestamp(),
        poll: pd ? { question: pd.question, labels: pd.labels } : null,
      }, { merge: true });
      const oldPoll = prev && !prev.ended ? this.deck.pollIdAt(prev.slide) : null;
      const newPoll = !pos.ended ? this.deck.pollIdAt(pos.slide) : null;
      if (oldPoll && oldPoll !== newPoll) b.set(this.ref(paths.poll(t, r, oldPoll)), { open: false }, { merge: true });
      if (newPoll) {
        const p = this.deck.pollDef(newPoll);
        // the question is copied in only now: phones never see a poll before the presenter reaches it
        b.set(this.ref(paths.poll(t, r, newPoll)), { question: p.question, labels: p.labels, options: p.labels.length, open: true }, { merge: true });
      }
    }
    this.lastWritten = pos;
    try { await b.commit(); } catch (e) { console.warn('[live] nav write failed', e.code || e); }
  }

  // ---------------- switches & controls ----------------
  async setSwitch(name, value) {
    if (!this.runId) return;
    const { F } = this.fb;
    try { await F.updateDoc(this.ref(paths.run(this.talkId, this.runId)), { [name]: value, updatedAt: F.serverTimestamp() }); } catch (e) { console.warn(e); }
  }
  async stopLive() {
    if (!this.runId) return;
    const { F } = this.fb;
    await F.updateDoc(this.ref(paths.run(this.talkId, this.runId)), { liveEnabled: false, reactionsEnabled: false, pollsEnabled: false, updatedAt: F.serverTimestamp() }).catch(console.warn);
    await F.setDoc(this.ref(paths.control(this.talkId, this.runId)), { cornerQr: false }, { merge: true }).catch(console.warn);
  }
  async setControl(field, value) {
    if (!this.runId) return;
    try { await this.fb.F.setDoc(this.ref(paths.control(this.talkId, this.runId)), { [field]: value }, { merge: true }); } catch (e) { console.warn(e); }
  }
  async setPollOpen(pollId, open) {
    if (!this.runId || !pollId) return;
    try { await this.fb.F.setDoc(this.ref(paths.poll(this.talkId, this.runId, pollId)), { open }, { merge: true }); } catch (e) { console.warn(e); }
  }

  // New run: fresh votes/reactions/joins, a new join code. The old run is switched off server-side.
  async newRun(pos = this.deck.first()) {
    const { F, db } = this.fb;
    const t = this.talkId, r = newRunId(), old = this.runId;
    const b = F.writeBatch(db);
    if (old) b.set(this.ref(paths.run(t, old)), { liveEnabled: false, reactionsEnabled: false, pollsEnabled: false }, { merge: true });
    b.set(this.ref(paths.run(t, r)), {
      ...this.deck.runFields(pos), liveEnabled: true, reactionsEnabled: true, pollsEnabled: true,
      by: this.role, startedAt: F.serverTimestamp(), updatedAt: F.serverTimestamp(),
    });
    b.set(this.ref(paths.secret(t, r)), { code: randomCode(6) });
    b.set(this.ref(paths.control(t, r)), { slide: pos.slide, step: pos.step, ended: !!pos.ended, by: this.role, cid: this.cid, cornerQr: true, blank: false, at: F.serverTimestamp() });
    const pollId = !pos.ended ? this.deck.pollIdAt(pos.slide) : null;
    if (pollId) {
      const p = this.deck.pollDef(pollId);
      b.set(this.ref(paths.poll(t, r, pollId)), { question: p.question, labels: p.labels, options: p.labels.length, open: true });
    }
    b.set(this.ref(paths.talk(t)), { activeRunId: r, title: this.deck.data.title }, { merge: true });
    await b.commit();
    return r;
  }

  // ---------------- listeners for results ----------------
  watchVotes(pollId, n, cb) {
    const { F } = this.fb;
    if (!this.runId) return () => {};
    return F.onSnapshot(F.collection(this.fb.db, paths.votes(this.talkId, this.runId, pollId)), (qs) => {
      const counts = new Array(n).fill(0);
      qs.forEach((d) => { const v = d.data().value; if (Number.isInteger(v) && v >= 0 && v < n) counts[v]++; });
      cb(counts);
    }, () => cb(null));
  }

  watchJoined(cb) {
    const { F } = this.fb;
    return F.onSnapshot(F.collection(this.fb.db, paths.joinedCol(this.talkId, this.runId)), (qs) => { this.joined = qs.size; cb(qs.size); }, () => {});
  }

  // Only reactions created after this listener started: the first snapshot is history and is skipped.
  watchReactions(cb) {
    const { F } = this.fb;
    const q = F.query(F.collection(this.fb.db, paths.reactions(this.talkId, this.runId)), F.orderBy('at'), F.limitToLast(100));
    let first = true;
    return F.onSnapshot(q, (qs) => {
      if (first) { first = false; return; }
      qs.docChanges().forEach((ch) => { if (ch.type === 'added') cb(ch.doc.data()); });
    }, () => {});
  }

  watchHeartbeat(cb) {
    const { F } = this.fb;
    return F.onSnapshot(this.ref(paths.heartbeat(this.talkId, this.runId)), (s) => cb(s.data() || null, s.metadata.fromCache), () => {});
  }
  async beat(stats) {
    if (!this.runId) return;
    const { F } = this.fb;
    try { await F.setDoc(this.ref(paths.heartbeat(this.talkId, this.runId)), { ...stats, at: F.serverTimestamp() }); } catch { /* offline */ }
  }
}
