import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../assets/sim-engine.js');

function near(a, b, tol) {
  assert.ok(Math.abs(a - b) <= tol, a + ' is not within ' + tol + ' of ' + b);
}

test('KV budget: 8B on a full H100 at 0.9 leaves ~54.94 GB', () => {
  const i = E.createInstance('7g.80gb', 'llama-3-8b', { gpuMemUtil: 0.9 });
  assert.equal(i.fits, true);
  near(i.kvBudget, 54.94e9, 0.01e9);           // 80*0.9 - 16.06 - 1
});
test('8B does not fit on a 1g.10gb slice', () => {
  const i = E.createInstance('1g.10gb', 'llama-3-8b', { gpuMemUtil: 0.9 });
  assert.equal(i.fits, false);
  assert.equal(i.kvBudget, 0);
});
test('roofline: one decode token on a full H100 is memory-bound', () => {
  near(E.stepTimeMs('7g.80gb', 'llama-3-8b', 0, 1, 0), 7.49, 0.05);   // 16.06e9 / (3.35e12*0.8) + 1.5
});
test('roofline: 1000 prefill tokens on a full H100 are compute-bound', () => {
  near(E.stepTimeMs('7g.80gb', 'llama-3-8b', 1000, 0, 0), 34.0, 0.2);  // 2*8.03e9*1000 / (989e12*0.5) + 1.5
});
test('roofline: KV reads count as memory traffic', () => {
  near(E.stepTimeMs('7g.80gb', 'llama-3-8b', 0, 64, 64 * 1500) - E.stepTimeMs('7g.80gb', 'llama-3-8b', 0, 64, 0), 4.69, 0.05);
});
test('roofline: a 2g.20gb slice is ~4x slower than the full GPU on decode', () => {
  near(E.stepTimeMs('2g.20gb', 'llama-3-8b', 0, 1, 0), 25.47, 0.1);  // bandwidth share 2/8
});

function run(sim, ms, each) {
  for (let t = 0; t < ms; t += 16) {
    E.tick(sim, 16);
    if (each) each(sim);
  }
}

test('tick clamps a huge dt (background tab) to 50 ms', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 1 });
  E.tick(sim, 600000);
  assert.ok(sim.t <= 50);
});
test('KV use never exceeds the budget under overload', () => {
  const sim = E.createSim({ seed: 1, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], batching: 'continuous', traffic: { rate: 30, bursts: true } });
  run(sim, 120000, s => s.instances.forEach(i => assert.ok(i.kvUsed <= i.kvBudget, `${i.kvUsed} > ${i.kvBudget}`)));
});
test('preemption: the newest sequence goes back to the front of its queue and still finishes', () => {
  const sim = E.createSim({ seed: 2, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], batching: 'continuous',
                            config: { gpuMemUtil: 0.45 }, traffic: { rate: 4, bursts: false } });   // ~0.94 GB of KV
  run(sim, 60000);
  assert.ok(sim.stats.preemptions > 0);
  sim.arrivalsOn = false; sim.pending = [];
  run(sim, 180000);
  assert.equal(sim.stats.arrived, sim.stats.finished + sim.stats.rejected);
});
test('router picks the instance with the fewest outstanding requests, lowest index on ties', () => {
  const sim = E.createSim({ seed: 3, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }, { profile: '4g.40gb', model: 'llama-3-8b' }], traffic: { rate: 0, bursts: false } });
  assert.equal(E.route(sim), sim.instances[0]);
  sim.instances[0].queue.push({}, {}, {});
  sim.instances[1].queue.push({});
  assert.equal(E.route(sim), sim.instances[1]);
});
test('router rejects (503) when every queue is at the cap', () => {
  const sim = E.createSim({ seed: 3, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], config: { queueCap: 2, gpuMemUtil: 0.45 }, traffic: { rate: 0, bursts: false } });
  for (let k = 0; k < 40; k++) E.enqueue(sim, { prompt: 2000, output: 200 });
  assert.ok(sim.stats.rejected > 0);
  assert.ok(sim.instances[0].queue.length <= 2);
});
test('a prompt that cannot fit the KV pool is rejected up front instead of blocking the queue', () => {
  const sim = E.createSim({ seed: 3, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], config: { gpuMemUtil: 0.45 }, traffic: { rate: 0, bursts: false } });
  assert.equal(sim.instances[0].maxModelLen, 7171);            // floor(0.94e9 / 131072)
  assert.equal(E.enqueue(sim, { prompt: 7000, output: 10 }).state, 'rejected');   // 7000 + 1024 > 7171
  assert.equal(E.enqueue(sim, { prompt: 1000, output: 10 }).state, 'queued');
  assert.equal(E.createSim({ ...E.PRESETS.batching, seed: 3 }).instances[0].maxModelLen, 8192);   // Llama 3's context window
});
test('a first token is recorded when prefill completes, and TTFT >= queue wait', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 6, traffic: { rate: 0, bursts: false } });
  const r = E.enqueue(sim, { prompt: 1000, output: 5 });
  run(sim, 2000);
  assert.equal(r.state, 'done');
  assert.ok(r.tFirst >= r.tAdmit && r.tAdmit >= r.t0);
  assert.equal(r.generated, 5);
});
test('a preempted sequence re-prefills its prompt plus what it made, from the queue front, and keeps its first-token time', () => {
  const sim = E.createSim({ seed: 1, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], config: { gpuMemUtil: 0.45 }, traffic: { rate: 0, bursts: false } });
  const inst = sim.instances[0];
  const a = E.enqueue(sim, { prompt: 3000, output: 1000 });
  const b = E.enqueue(sim, { prompt: 3000, output: 1000 });
  while (b.preemptions === 0 && sim.t < 60000) E.tick(sim, 16);
  assert.ok(b.preemptions > 0, 'b was never preempted');
  assert.equal(inst.queue[0], b);                               // newest out, back to the front
  assert.equal(b.generated, 585);                                // 2 * 3001 + 2 * 585 > 7171 tokens of KV
  assert.equal(b.prefillTarget, 3000 + 585);
  assert.equal(a.state, 'running');
  const tFirst = b.tFirst;
  run(sim, 60000);
  assert.equal(b.state, 'done');
  assert.equal(b.generated, 1000);
  assert.equal(b.tFirst, tFirst);
});
test('router skips an instance whose queue is at the cap, even when it has the fewest outstanding', () => {
  const sim = E.createSim({ seed: 3, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }, { profile: '4g.40gb', model: 'llama-3-8b' }],
                            config: { queueCap: 2 }, traffic: { rate: 0, bursts: false } });
  sim.instances[0].queue.push({}, {});                 // full, 2 outstanding
  sim.instances[1].running.push({}, {}, {});           // room, 3 outstanding
  assert.equal(E.route(sim), sim.instances[1]);
  const r = E.enqueue(sim, { prompt: 1000, output: 10 });
  assert.equal(r.state, 'queued');
  assert.equal(r.inst, 1);
  assert.equal(sim.stats.rejected, 0);
});
test('router sends a prompt too long for one instance to another that can hold it', () => {
  const sim = E.createSim({ seed: 3, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }, { profile: '7g.80gb', model: 'llama-3-8b' }],
                            config: { gpuMemUtil: 0.45 }, traffic: { rate: 0, bursts: false } });
  assert.equal(sim.instances[0].maxModelLen, 7171);
  assert.equal(sim.instances[1].maxModelLen, 8192);
  const r = E.enqueue(sim, { prompt: 6500, output: 10 });     // 6500 + 1024 fits 8192, not 7171
  assert.equal(r.state, 'queued');
  assert.equal(r.inst, 1);
  assert.equal(E.enqueue(sim, { prompt: 7500, output: 10 }).state, 'rejected');   // fits neither
});

test('request-level batch size is capped by the up-front KV reservation', () => {
  const sim = E.createSim({ seed: 1, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], batching: 'request',
                            config: { gpuMemUtil: 0.45 }, traffic: { rate: 0, bursts: false } });
  for (let k = 0; k < 6; k++) E.enqueue(sim, { prompt: 2000, output: 50 });
  E.tick(sim, 30);                                  // past maxQueueDelayMs
  assert.equal(sim.instances[0].running.length, 2); // 0.94e9 / ((2000+1024)*131072) = 2.37
});
test('a request-level batch holds finished sequences as idle slots until its longest one ends', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 1, batching: 'request', traffic: { rate: 0, bursts: false } });
  const short = E.enqueue(sim, { prompt: 100, output: 3 });
  const long = E.enqueue(sim, { prompt: 100, output: 300 });
  run(sim, 600);
  assert.equal(short.state, 'idle');
  assert.equal(sim.instances[0].running.length, 2);
  run(sim, 10000);
  assert.equal(long.state, 'done');
  assert.equal(sim.instances[0].running.length, 0);
});
test('continuous batching beats request-level (same seed, tab 01 preset)', () => {
  const a = E.createSim({ ...E.PRESETS.batching, seed: 7, batching: 'continuous' }); run(a, 60000);
  const b = E.createSim({ ...E.PRESETS.batching, seed: 7, batching: 'request' }); run(b, 60000);
  assert.ok(E.metrics(a).ttftP99 * 2 <= E.metrics(b).ttftP99);
  assert.ok(E.metrics(a).tokPerSec > E.metrics(b).tokPerSec);
});
test('toggling modes mid-flight loses and duplicates nothing', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 8 });
  for (let k = 0; k < 6; k++) { run(sim, 10000); E.setBatching(sim, k % 2 ? 'continuous' : 'request'); }
  sim.arrivalsOn = false; sim.pending = [];
  run(sim, 240000);
  assert.equal(sim.stats.arrived, sim.stats.finished + sim.stats.rejected);
  assert.equal(new Set(sim.finished.map(r => r.id)).size, sim.finished.length);
  assert.equal(sim.events.length, 6);
});
test('switching to continuous mid-batch drops the idle slots, frees the reservation and logs the event', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 1, batching: 'request', traffic: { rate: 0, bursts: false } });
  const inst = sim.instances[0], kv = E.MODELS['llama-3-8b'].kvBytesPerToken;
  const short = E.enqueue(sim, { prompt: 100, output: 3 });
  const long = E.enqueue(sim, { prompt: 100, output: 300 });
  run(sim, 600);
  assert.equal(inst.kvUsed, 2 * (100 + 1024) * kv);         // the reservation, not the tokens held
  E.setBatching(sim, 'continuous');
  assert.deepEqual(sim.events, [{ t: sim.t, label: 'continuous on' }]);
  assert.deepEqual(inst.running, [long]);
  assert.equal(short.state, 'done');
  assert.equal(inst.kvUsed, long.kvTokens * kv);
  run(sim, 10000);
  assert.equal(long.state, 'done');
  assert.equal(sim.stats.finished, 2);                       // short was counted once, when it went idle
});
test('after a switch to request-level, running sequences finish as a legacy batch that nobody joins', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 1, traffic: { rate: 0, bursts: false } });
  const long = E.enqueue(sim, { prompt: 100, output: 300 });
  run(sim, 500);
  E.setBatching(sim, 'request');
  assert.equal(sim.events[0].label, 'request-level on');
  const next = E.enqueue(sim, { prompt: 100, output: 5 });
  run(sim, 1000);
  assert.equal(long.state, 'running');
  assert.equal(next.state, 'queued');
  run(sim, 10000);
  assert.equal(next.state, 'done');
  assert.ok(next.tAdmit >= long.tDone);
  assert.equal(sim.stats.finished, 2);
});

test('pause drains: in-flight work finishes and nothing new arrives', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 4 });
  run(sim, 20000);
  const arrived = sim.stats.arrived;
  E.setArrivals(sim, false);
  assert.equal(E.playState(sim, false), 'draining');
  run(sim, 120000);
  assert.equal(sim.stats.arrived, arrived);
  assert.ok(E.isDrained(sim));
  assert.equal(E.playState(sim, false), 'stopped');
  assert.equal(sim.stats.arrived, sim.stats.finished + sim.stats.rejected);
});
test('once drained, throughput is 0 and cost is –, while TTFT and TPOT keep their last values', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 4 });
  run(sim, 20000);
  E.setArrivals(sim, false);
  while (!E.isDrained(sim) && sim.t < 200000) E.tick(sim, 16);   // the page stops the clock right here
  assert.ok(E.isDrained(sim));
  const m = E.metrics(sim);
  assert.equal(m.tokPerSec, 0);
  assert.equal(m.costPer1M, null);
  assert.equal(E.fmt.tok(m.tokPerSec), '0 tok/s');
  assert.equal(E.fmt.usd(m.costPer1M), '–');
  assert.ok(m.ttftP99 > 0 && m.tpotMs > 0);
  assert.equal(m.kvFrac, 0);
});
test('a burst while paused is served without restarting the flow', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 4 });
  E.setArrivals(sim, false); run(sim, 120000);
  const before = sim.stats.arrived;
  E.sendBurst(sim, 10); run(sim, 60000);
  assert.equal(sim.stats.arrived, before + 10);
  assert.ok(E.isDrained(sim));
  assert.equal(sim.arrivalsOn, false);
});
test('play resumes arrivals', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 4 });
  E.setArrivals(sim, false); run(sim, 120000);
  const before = sim.stats.arrived;
  E.setArrivals(sim, true); run(sim, 5000);
  assert.ok(sim.stats.arrived > before);
  assert.equal(E.playState(sim, false), 'running');
});
test('frozen (reduced motion) reports stopped', () => {
  assert.equal(E.playState(E.createSim({ ...E.PRESETS.batching, seed: 4 }), true), 'stopped');
});
test('metrics are null before data and format as –', () => {
  const m = E.metrics(E.createSim({ ...E.PRESETS.batching, seed: 5 }));
  assert.equal(m.ttftP99, null);
  assert.equal(E.fmt.ms(m.ttftP99), '–');
  assert.equal(E.fmt.usd(m.costPer1M), '–');
});
test('formatting', () => {
  assert.equal(E.fmt.ms(95.4), '95ms');
  assert.equal(E.fmt.ms(1240), '1.24s');
  assert.equal(E.fmt.tok(6812.3), '6,812 tok/s');
  assert.equal(E.fmt.pct(0.614), '61%');
  assert.equal(E.fmt.usd(0.1234), '$0.12 / 1M tok');
  // a target next to a p99 drops trailing zeros; spoken forms (the canvas's aria-label) have a space
  assert.deepEqual([2000, 1500, 500, 300].map(E.fmt.slo), ['2s', '1.5s', '500ms', '300ms']);
  assert.deepEqual([1840, 2000, 85.4, null].map(E.fmt.spoken), ['1.84 s', '2 s', '85 ms', 'not measured yet']);
});
test('finished requests are pruned so memory stays bounded under burst spam', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 9 });
  for (let k = 0; k < 20; k++) E.sendBurst(sim, 24);
  run(sim, 180000);
  assert.ok(sim.finished.length <= 500);
  sim.instances.forEach(i => assert.ok(i.queue.length <= sim.cfg.queueCap));
});
test('metrics report latency, throughput, KV and cost once there is data', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 4 });
  run(sim, 30000);
  const m = E.metrics(sim);
  for (const key of ['ttftP50', 'ttftP99', 'tpotMs', 'tokPerSec', 'kvFrac', 'costPer1M']) assert.ok(m[key] > 0, key);
  assert.ok(m.ttftP50 <= m.ttftP99);
  assert.equal(m.rejected, sim.stats.rejected);
  near(m.costPer1M, E.GPU_HOUR_USD / 3600 / m.tokPerSec * 1e6, 1e-9);
  assert.match(E.GPU_HOUR_SOURCE, /2026-10-25/);
});

test('unknown profile or model throws a clear error', () => {
  assert.throws(() => E.createInstance('9g.90gb', 'llama-3-8b', {}), /unknown MIG profile: 9g\.90gb/);
  assert.throws(() => E.createInstance('7g.80gb', 'gpt-x', {}), /unknown model: gpt-x/);
});
test('null or NaN config values fall back to the defaults', () => {
  near(E.createInstance('7g.80gb', 'llama-3-8b', { gpuMemUtil: NaN }).kvBudget, 54.94e9, 0.01e9);
  near(E.createInstance('7g.80gb', 'llama-3-8b', { gpuMemUtil: null }).kvBudget, 54.94e9, 0.01e9);
  assert.equal(E.createSim({ ...E.PRESETS.batching, seed: 1, config: { queueCap: NaN } }).cfg.queueCap, 128);
});
test('no waiting request, the preempted one included, is admitted in a step that preempted (vLLM V1)', () => {
  // A small token budget, so the preempted sequence's re-prefill chunk would fit right after the preemption
  const sim = E.createSim({ seed: 2, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], batching: 'continuous',
                            config: { gpuMemUtil: 0.45, maxNumBatchedTokens: 512 }, traffic: { rate: 4, bursts: false } });
  const inst = sim.instances[0];
  let checked = 0;
  for (let t = 0; t < 120000; t += 1) {   // 1 ms ticks: at most one plan per instance per tick (a step is >= 1.5 ms)
    const before = sim.stats.preemptions, stayed = new Map(inst.running.map(r => [r.id, r.preemptions]));
    E.tick(sim, 1);
    if (sim.stats.preemptions > before) {
      checked += 1;
      for (const r of inst.running) {
        assert.ok(stayed.has(r.id), `request ${r.id} was queued and admitted in a preempting step`);
        assert.equal(r.preemptions, stayed.get(r.id), `request ${r.id} was preempted and re-admitted in the same step`);
      }
    }
  }
  assert.ok(checked > 0);
});
test('canAdmit: continuous mode, empty queue, room under max-num-seqs and in the KV pool', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 1, traffic: { rate: 0, bursts: false } });
  const inst = sim.instances[0];
  assert.equal(E.canAdmit(sim, inst), true);
  E.enqueue(sim, { prompt: 100, output: 5 });
  assert.equal(E.canAdmit(sim, inst), false);   // the queue head goes first
  run(sim, 2000);
  assert.equal(E.canAdmit(sim, inst), true);
  E.setBatching(sim, 'request');
  assert.equal(E.canAdmit(sim, inst), false);
});

const two = (extra = {}) => E.createSim(Object.assign({ seed: 1,
  instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }, { profile: '2g.20gb', model: 'llama-3.2-1b' }],
  streams: [{ model: 'llama-3-8b', rate: 0 }, { model: 'llama-3.2-1b', rate: 0 }] }, extra));
test('Llama 3.2 3B and 1B: KV per token and KV budget on a 2g.20gb slice', () => {
  assert.equal(E.MODELS['llama-3.2-3b'].kvBytesPerToken, 114688);
  assert.equal(E.MODELS['llama-3.2-1b'].kvBytesPerToken, 32768);
  near(E.createInstance('2g.20gb', 'llama-3.2-3b', { gpuMemUtil: 0.9 }).kvBudget, 10.57e9, 0.01e9);   // 18 - 6.43 - 1
  near(E.createInstance('2g.20gb', 'llama-3.2-1b', { gpuMemUtil: 0.9 }).kvBudget, 14.53e9, 0.01e9);   // 18 - 2.47 - 1
  assert.deepEqual(['llama-3-8b', 'llama-3.2-3b', 'llama-3.2-1b'].map(m => E.MODELS[m].short), ['8B', '3B', '1B']);
});
test('an instance spec can set its own gpuMemUtil', () => {
  const sim = E.createSim({ seed: 1, instances: [{ profile: '7g.80gb', model: 'llama-3-8b', gpuMemUtil: 0.45 }], traffic: { rate: 0 } });
  near(sim.instances[0].kvBudget, 18.94e9, 0.01e9);   // 36 - 16.06 - 1
});
test('requests only go to instances serving their model', () => {
  const sim = two();
  assert.equal(E.route(sim, 100, 'llama-3.2-1b'), sim.instances[1]);
  assert.equal(E.enqueue(sim, { prompt: 100, output: 5, model: 'llama-3-8b' }).inst, 0);
  const r = E.enqueue(sim, { prompt: 100, output: 5, model: 'llama-3.2-1b' });
  assert.deepEqual([r.inst, r.model], [1, 'llama-3.2-1b']);
});
test('each stream arrives at its own rate, with its own model', () => {
  const sim = two({ streams: [{ model: 'llama-3-8b', rate: 1 }, { model: 'llama-3.2-1b', rate: 4,
    lengths: { prompt: { median: 120, sigma: 0.5, min: 8, max: 1000 }, output: { median: 16, sigma: 0.5, min: 1, max: 120 } } }] });
  run(sim, 60000); E.setArrivals(sim, false); run(sim, 120000);
  const n = m => sim.finished.filter(r => r.model === m).length;
  assert.ok(n('llama-3-8b') >= 45 && n('llama-3-8b') <= 75, String(n('llama-3-8b')));
  assert.ok(n('llama-3.2-1b') >= 200 && n('llama-3.2-1b') <= 280, String(n('llama-3.2-1b')));
});
test('a burst goes to the stream it names', () => {
  const sim = two();
  E.setArrivals(sim, false); E.sendBurst(sim, 10, 1); run(sim, 30000);   // arrivals off first: turning them off drops pending ones
  assert.equal(sim.finished.length, 10);
  assert.ok(sim.finished.every(r => r.model === 'llama-3.2-1b'));
});
test('per-model metrics filter TTFT and TPOT by model', () => {
  const sim = two();
  for (let k = 0; k < 20; k++) { E.enqueue(sim, { prompt: 3000, output: 20, model: 'llama-3-8b' }); E.enqueue(sim, { prompt: 50, output: 20, model: 'llama-3.2-1b' }); }
  run(sim, 20000);
  assert.ok(E.metrics(sim, 'llama-3.2-1b').ttftP99 < E.metrics(sim, 'llama-3-8b').ttftP99);
  assert.equal(E.metrics(sim, 'llama-3.2-3b').ttftP99, null);
  assert.equal(E.metrics(sim, 'llama-3.2-3b').tpotMs, null);
  // each model's TPOT is its own requests': the 8B on a 3g slice decodes slower than the 1B on a 2g slice
  const tpot8 = E.metrics(sim, 'llama-3-8b').tpotMs, tpot1 = E.metrics(sim, 'llama-3.2-1b').tpotMs;
  assert.ok(tpot1 > 0 && tpot8 > tpot1, `8B ${tpot8} vs 1B ${tpot1}`);
});
test('GPU count is the number of distinct physical GPUs, and cost scales with it', () => {
  const three = E.createSim({ seed: 1, traffic: { rate: 6, bursts: false },
    instances: [0, 1, 2].map(g => ({ profile: '7g.80gb', model: 'llama-3-8b', gpu: g })) });
  assert.equal(three.gpuCount, 3);
  assert.equal(two().gpuCount, 1);
  run(three, 20000);
  const m = E.metrics(three);
  near(m.costPer1M, E.GPU_HOUR_USD * 3 / 3600 / m.tokPerSec * 1e6, 1e-9);
});
test('per-model TTFT keeps a quiet model\'s samples when a busier model fills the last 200', () => {
  const sim = two();
  for (let k = 0; k < 10; k++) E.enqueue(sim, { prompt: 100, output: 5, model: 'llama-3-8b' });
  run(sim, 2000);
  for (let b = 0; b < 3; b++) {   // 300 first tokens on the 1B, in batches under the queue cap
    for (let k = 0; k < 100; k++) E.enqueue(sim, { prompt: 20, output: 2, model: 'llama-3.2-1b' });
    run(sim, 1000);
  }
  assert.equal(sim.stats.finished, 310);
  assert.notEqual(E.metrics(sim, 'llama-3-8b').ttftP99, null);
  assert.notEqual(E.metrics(sim).ttftP99, null);
});
test('TTFT metrics cover the last 30 s by default, and up to 120 s when a window is given', () => {
  const sim = E.createSim({ seed: 1, instances: [{ profile: '7g.80gb', model: 'llama-3-8b' }], traffic: { rate: 0, bursts: false } });
  for (let k = 0; k < 40; k++) E.enqueue(sim, { prompt: 6000, output: 2 });   // a pile-up at t = 0: first tokens over ~8 s
  run(sim, 40000);
  for (let k = 0; k < 10; k++) E.enqueue(sim, { prompt: 50, output: 2 });     // quick ones at t = 40 s
  run(sim, 5000);
  const pileUp = sim.finished.filter(r => r.prompt === 6000);
  assert.equal(pileUp.length, 40);
  assert.ok(pileUp.every(r => r.tFirst < sim.t - 30000 && r.tFirst - r.t0 > 200));
  // default: the pile-up is older than 30 s, so only the quick ones count, as before the log kept 120 s
  const m = E.metrics(sim);
  assert.ok(m.ttftP99 < 100, `default p99 ${m.ttftP99}`);
  assert.deepEqual(E.metrics(sim, undefined, 30000), m);
  assert.deepEqual(E.metrics(sim, 'llama-3-8b'), E.metrics(sim, 'llama-3-8b', 30000));
  // a 120 s window reaches back past 30 s, whole-sim and per model
  const slowest = Math.max(...pileUp.map(r => r.tFirst - r.t0));
  assert.equal(E.metrics(sim, undefined, 120000).ttftP99, slowest);
  assert.equal(E.metrics(sim, 'llama-3-8b', 120000).ttftP99, slowest);
  assert.equal(E.metrics(sim, 'llama-3.2-1b', 120000).ttftP99, null);
});
test('a longer TTFT window takes proportionally more samples: 200 per 30 s', () => {
  const sim = E.createSim({ seed: 1, instances: [{ profile: '7g.80gb', model: 'llama-3-8b' }], traffic: { rate: 0, bursts: false } });
  sim.t = 100000;
  for (let k = 0; k < 500; k++) sim.ttftLog.push([10000 + k * 100, k < 10 ? 5000 : 10, 'llama-3-8b']);   // 50 s of first tokens, the oldest 10 slow
  assert.equal(E.metrics(sim).ttftP99, null);                              // all older than 30 s
  assert.equal(E.metrics(sim, 'llama-3-8b', 120000).ttftP99, 5000);       // up to 800 samples: all 500, 2% slow
});
test('a stream, burst or request naming something unknown throws a clear error', () => {
  const inst = [{ profile: '7g.80gb', model: 'llama-3-8b' }];
  assert.throws(() => E.createSim({ seed: 1, instances: inst, streams: [{ model: 'gpt-x', rate: 1 }] }), /unknown model: gpt-x/);
  assert.throws(() => E.createSim({ seed: 1, instances: inst }), /needs streams or traffic/);
  assert.throws(() => E.enqueue(two(), { prompt: 10, output: 1, model: 'gpt-x' }), /unknown model: gpt-x/);
  assert.throws(() => E.sendBurst(two(), 3, 2), /unknown stream: 2/);
  assert.equal(E.enqueue(two(), { prompt: 10, output: 1, model: 'llama-3.2-3b' }).state, 'rejected');   // known, but no instance: a 503
});

function kvRun(util, seed) {
  const sim = E.createSim(Object.assign({}, E.PRESETS.kvcache, { seed, config: { gpuMemUtil: util } }));
  let peak = 0;
  run(sim, 120000, s => { const i = s.instances[0]; peak = Math.max(peak, i.kvUsed / i.kvBudget); });
  return { sim, peak };
}
test('tab 02: every slider position from 0.5 to 0.95 starts the server and fits the longest prompt', () => {
  for (let u = 0.5; u <= 0.9501; u += 0.05) {
    const inst = E.createSim(Object.assign({}, E.PRESETS.kvcache, { seed: 1, config: { gpuMemUtil: u } })).instances[0];
    assert.ok(inst.fits, String(u));
    assert.ok(inst.maxModelLen >= E.PRESETS.kvcache.traffic.lengths.prompt.max + 1024, String(u));
  }
});
const KV_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];   // the page draws a random seed, so the lesson must not hang on one
test('tab 02: at the default 0.9 the KV pool fills and the scheduler preempts, on every seed', () => {
  for (const seed of KV_SEEDS) {
    const r = kvRun(0.9, seed);
    assert.ok(r.peak >= 0.9, `seed ${seed}: peak ${r.peak}`);
    assert.ok(r.sim.stats.preemptions > 0, `seed ${seed}: no preemptions`);
  }
});
// The first 60 s at one slider position: the mean number of requests running (over 16 ms ticks), the
// requests finished, and when the first preemption came (Infinity if none). Memoised: three tests read it.
const kvSliderRuns = {};
function kvSlider(util, seed) {
  const key = util + '/' + seed;
  if (kvSliderRuns[key]) return kvSliderRuns[key];
  const sim = E.createSim(Object.assign({}, E.PRESETS.kvcache, { seed, config: { gpuMemUtil: util } }));
  let sum = 0, n = 0, first = Infinity;
  run(sim, 60000, s => {
    sum += s.instances[0].running.length; n += 1;
    if (first === Infinity && s.stats.preemptions > 0) first = s.t;
  });
  return (kvSliderRuns[key] = { running: sum / n, finished: sim.stats.finished, first });
}
function median(values) {
  const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
test('tab 02: more KV memory fits more requests at once (0.5 < 0.9 < 0.95), on every seed', () => {
  for (const seed of KV_SEEDS) {
    const r = [0.5, 0.9, 0.95].map(u => kvSlider(u, seed).running);
    assert.ok(r[0] < r[1] && r[1] < r[2], `seed ${seed}: mean running ${r.map(v => v.toFixed(1))}`);
  }
});
test('tab 02: at 0.95 the server finishes more requests than at 0.5, on every seed', () => {
  for (const seed of KV_SEEDS) {
    const lo = kvSlider(0.5, seed).finished, hi = kvSlider(0.95, seed).finished;
    assert.ok(hi > lo, `seed ${seed}: ${hi} vs ${lo}`);
  }
});
test('tab 02: with less KV memory preemption starts sooner (median over seeds)', () => {
  const lo = median(KV_SEEDS.map(seed => kvSlider(0.5, seed).first)), hi = median(KV_SEEDS.map(seed => kvSlider(0.9, seed).first));
  assert.ok(lo < hi, `first preemption at 0.5 ${lo} ms vs 0.9 ${hi} ms`);
});

// What a visitor sees after opening a tab or switching a deployment, as assets/sim.js does it: the warm-up
// (WARMUP_TICKS or TAB03_WARMUP_TICKS x TICK_MS), then a footer refresh every SAMPLE_MS of sim time on the
// same schedule, with each box's p99 over P99_WINDOW_MS. tests/test_page.py checks these against sim.js.
const PAGE = { tickMs: 16, warmMs: 8000, tab03WarmMs: 40000, sampleMs: 300, p99WindowMs: 30000 };
const VIEW_SEEDS = Array.from({ length: 20 }, (_, k) => k + 1);
// Warms the sim up like the page, then calls look(sim) at the footer refresh right after the warm-up and
// at every refresh over the next watchMs
function visit(sim, warmMs, watchMs, look) {
  let next = PAGE.sampleMs;
  for (let k = 0; k < warmMs / PAGE.tickMs; k++) {
    E.tick(sim, PAGE.tickMs);
    if (sim.t >= next) next += PAGE.sampleMs;
  }
  const end = sim.t + watchMs;
  look(sim);
  while (sim.t < end) {
    E.tick(sim, PAGE.tickMs);
    if (sim.t >= next) { next += PAGE.sampleMs; look(sim); }
  }
}
test('tab 02 as a visitor sees it: in the 30 s after opening at 0.9, KV passes 90% on 90% of loads and a preemption comes on 80%', () => {
  let full = 0, preempted = 0;
  for (const seed of VIEW_SEEDS) {
    const sim = E.createSim(Object.assign({}, E.PRESETS.kvcache, { seed, config: { gpuMemUtil: 0.9 } }));
    let kv = 0, opened = null;
    visit(sim, PAGE.warmMs, 30000, s => {
      if (opened === null) opened = s.stats.preemptions;
      kv = Math.max(kv, E.metrics(s).kvFrac);
    });
    if (kv > 0.9) full += 1;
    if (sim.stats.preemptions > opened) preempted += 1;
  }
  assert.ok(full >= 0.9 * VIEW_SEEDS.length, `KV above 90% on ${full}/${VIEW_SEEDS.length} loads`);
  assert.ok(preempted >= 0.8 * VIEW_SEEDS.length, `a preemption on ${preempted}/${VIEW_SEEDS.length} loads`);
});

const preset = (id, seed) => E.createSim(Object.assign({}, E.PRESETS[id], { seed }));
const TAB3_SEEDS = [1, 2, 3, 4, 5];   // the page draws a random seed, so the lesson must not hang on one
test('instances sharing a whole GPU are time-sliced; MIG slices and separate GPUs are not', () => {
  assert.deepEqual(preset('mig-time', 1).instances.map(i => i.timeSliced), [true, true, true]);
  assert.deepEqual(preset('mig-mig', 1).instances.map(i => i.timeSliced), [false, false, false]);
  assert.deepEqual(preset('mig-gpu', 1).instances.map(i => i.timeSliced), [false, false, false]);
});
test('alone a time-sliced process runs at full speed; with a busy neighbour its step stretches', () => {
  const sim = E.createSim({ seed: 1, streams: [{ model: 'llama-3-8b', rate: 0 }, { model: 'llama-3.2-1b', rate: 0 }],
    instances: [{ profile: '7g.80gb', model: 'llama-3-8b', gpu: 0, gpuMemUtil: 0.45 }, { profile: '7g.80gb', model: 'llama-3.2-1b', gpu: 0, gpuMemUtil: 0.2 }] });
  const i1 = sim.instances[1], cost = s => E.stepTimeMs('7g.80gb', 'llama-3.2-1b', s.prefill, s.decode, s.kvRead);
  // Shared, only the GPU part of a step stretches, and 30% of the GPU's time goes to context switches
  const sliced = (s, k) => E.GPU.stepOverheadMs + k * (cost(s) - E.GPU.stepOverheadMs) / 0.7;
  E.enqueue(sim, { prompt: 100, output: 400, model: 'llama-3.2-1b' });
  E.tick(sim, 1);
  assert.equal(i1.step.stretch, 1);
  near(i1.stepEnd - i1.step.start, cost(i1.step), 1e-9);
  E.enqueue(sim, { prompt: 6000, output: 50, model: 'llama-3-8b' });
  let seen = false;
  for (let t = 0; t < 2000 && !seen; t += 1) {
    E.tick(sim, 1);
    if (i1.step && i1.step.stretch === 2) { seen = true; near(i1.stepEnd - i1.step.start, sliced(i1.step, 2), 1e-9); }
  }
  assert.ok(seen);
});
test('a step carries its cost and stretch in both batching modes, with stretch 1 when not time-sliced', () => {
  for (const batching of ['continuous', 'request']) {
    const sim = E.createSim({ seed: 1, batching, instances: [{ profile: '7g.80gb', model: 'llama-3-8b' }], traffic: { rate: 0, bursts: false } });
    const inst = sim.instances[0];
    E.enqueue(sim, { prompt: 500, output: 20 });
    E.tick(sim, 30);   // past maxQueueDelayMs, so a request-level batch has formed
    assert.ok(inst.step, batching);
    for (const key of ['start', 'items', 'prefill', 'decode', 'kvRead', 'stretch']) assert.ok(key in inst.step, `${batching}: ${key}`);
    assert.equal(inst.step.stretch, 1);
    near(inst.stepEnd - inst.step.start, E.stepTimeMs('7g.80gb', 'llama-3-8b', inst.step.prefill, inst.step.decode, inst.step.kvRead), 1e-9);
  }
});
test('tab 03: GPU per model and MIG both meet every SLO on every seed, and MIG uses one GPU instead of three', () => {
  for (const id of ['mig-gpu', 'mig-mig']) {
    for (const seed of TAB3_SEEDS) {
      const sim = preset(id, seed);
      run(sim, 120000);
      for (const [model, slo] of Object.entries(sim.slo)) {
        const p99 = E.metrics(sim, model).ttftP99;
        assert.ok(p99 !== null && p99 <= slo, `${id} seed ${seed} ${model}: ${p99} > ${slo}`);
      }
    }
  }
  assert.deepEqual(['mig-gpu', 'mig-time', 'mig-mig'].map(id => preset(id, 5).gpuCount), [3, 1, 1]);
});
// Each model's TTFT p99 after 120 s, median over the seeds, in sim.slo's order (8B, 3B, 1B)
function tab3Medians(id) {
  const rows = TAB3_SEEDS.map(seed => {
    const sim = preset(id, seed);
    run(sim, 120000);
    return Object.keys(sim.slo).map(model => E.metrics(sim, model).ttftP99);
  });
  return rows[0].map((_, i) => {
    const col = rows.map(r => r[i]);
    assert.ok(col.every(v => v !== null), `${id}: no TTFT data`);
    return col.sort((a, b) => a - b)[Math.floor(col.length / 2)];
  });
}
test('tab 03: time-slicing is slower than MIG for every model (median p99 over seeds)', () => {
  const time = tab3Medians('mig-time'), mig = tab3Medians('mig-mig');
  Object.keys(E.PRESETS['mig-time'].slo).forEach((model, i) => assert.ok(time[i] > mig[i], `${model}: time-slicing ${time[i]} vs MIG ${mig[i]}`));
});
test('tab 03: time-slicing misses at least one model\'s SLO (median p99 over seeds)', () => {
  const slo = E.PRESETS['mig-time'].slo, time = tab3Medians('mig-time');
  assert.ok(Object.keys(slo).some((model, i) => time[i] > slo[model]), `time-slicing medians ${time} all within ${Object.values(slo)}`);
});
// Each box as a visitor sees it after switching to a deployment: the tab 03 warm-up, then a refresh every
// 300 ms for watchMs. Per model, in sim.slo's order, whether each refresh showed the box red (p99 over its SLO).
function boxesRed(id, seed, watchMs) {
  const sim = preset(id, seed), models = Object.keys(sim.slo), red = models.map(() => []);
  visit(sim, PAGE.tab03WarmMs, watchMs, s => models.forEach((model, i) => {
    const p99 = E.metrics(s, model, PAGE.p99WindowMs).ttftP99;
    red[i].push(p99 !== null && p99 > s.slo[model]);
  }));
  return red;
}
const redShare = list => list.filter(Boolean).length / list.length;
test('tab 03 as a visitor sees it: in the 30 s after a switch to time-slicing, the 8B box is red on 70% of refreshes (median over loads)', () => {
  const shares = VIEW_SEEDS.map(seed => redShare(boxesRed('mig-time', seed, 30000)[0]));
  assert.ok(median(shares) >= 0.7, `median ${median(shares)}; per load ${shares.map(v => v.toFixed(2))}`);
});
test('tab 03 as a visitor sees it: under MIG and GPU per model every box is red on at most 1% of refreshes over 2 min, with no manual burst', () => {
  for (const id of ['mig-mig', 'mig-gpu']) {
    const loads = VIEW_SEEDS.map(seed => boxesRed(id, seed, 120000));
    Object.keys(E.PRESETS[id].slo).forEach((model, i) => {
      const share = redShare(loads.flatMap(red => red[i]));
      assert.ok(share <= 0.01, `${id} ${model}: red on ${(100 * share).toFixed(2)}% of refreshes`);
    });
  }
});
// The spec's noisy neighbour, with the 8B quiet (rate 0, no automatic bursts): after 40 s, four bursts of 40
// requests on the 8B, each followed by 5 s. The 1B's p99 just before against the highest it shows at the
// page's 300 ms refreshes during the bursts.
function neighbourEffect(id, seed) {
  const p = E.PRESETS[id];
  const sim = E.createSim(Object.assign({}, p, { seed, streams: p.streams.map((s, i) => i === 0 ? Object.assign({}, s, { rate: 0, bursts: false }) : s) }));
  run(sim, 40000);
  const before = E.metrics(sim, 'llama-3.2-1b', PAGE.p99WindowMs).ttftP99;
  let peak = 0, next = sim.t + PAGE.sampleMs;
  for (let k = 0; k < 4; k++) {
    E.sendBurst(sim, 40, 0);
    run(sim, 5000, s => {
      if (s.t >= next) { next += PAGE.sampleMs; peak = Math.max(peak, E.metrics(s, 'llama-3.2-1b', PAGE.p99WindowMs).ttftP99); }
    });
  }
  return peak / before;
}
test('tab 03: bursts on a quiet 8B raise the 1B\'s p99 under time-slicing (≥ 1.5×), not under MIG (≤ 1.3×), median over seeds', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const time = median(seeds.map(seed => neighbourEffect('mig-time', seed))), mig = median(seeds.map(seed => neighbourEffect('mig-mig', seed)));
  assert.ok(time >= 1.5, `time-slicing ×${time}`);
  assert.ok(mig <= 1.3, `MIG ×${mig}`);
});

test('prefillProgress: 0 before admission, between 0 and 1 mid-chunk, 1 after prefill', () => {
  const sim = E.createSim({ seed: 1, instances: [{ profile: '7g.80gb', model: 'llama-3-8b' }], batching: 'continuous', traffic: { rate: 0, bursts: false } });
  const inst = sim.instances[0];
  const r = E.enqueue(sim, { prompt: 4000, output: 20 });
  assert.equal(E.prefillProgress(sim, inst, r), 0);
  let mid = null;
  for (let t = 0; t < 3000 && r.generated === 0; t++) {
    E.tick(sim, 1);
    const p = E.prefillProgress(sim, inst, r);
    assert.ok(p >= 0 && p <= 1);
    if (p > 0 && p < 1 && mid === null) mid = p;
  }
  assert.ok(mid !== null && mid > 0 && mid < 1);
  assert.equal(E.prefillProgress(sim, inst, r), 1);
});
test('slotSteps counts the decode steps a request-level batch has run, 0 when none', () => {
  const sim = E.createSim({ ...E.PRESETS.batching, seed: 1, batching: 'request', traffic: { rate: 0, bursts: false } });
  const inst = sim.instances[0];
  assert.equal(E.slotSteps(inst), 0);
  E.enqueue(sim, { prompt: 100, output: 3 });
  E.enqueue(sim, { prompt: 100, output: 300 });
  run(sim, 600);
  assert.ok(inst.batch && inst.batch.steps > 3);
  assert.equal(E.slotSteps(inst), inst.batch.steps);
  run(sim, 10000);
  assert.equal(E.slotSteps(inst), 0);
});
test('stretchNow is 2 for a time-sliced instance with a busy neighbour and 1 alone or idle', () => {
  const sim = E.createSim({ seed: 1, streams: [{ model: 'llama-3-8b', rate: 0 }, { model: 'llama-3.2-1b', rate: 0 }],
    instances: [{ profile: '7g.80gb', model: 'llama-3-8b', gpu: 0, gpuMemUtil: 0.45 }, { profile: '7g.80gb', model: 'llama-3.2-1b', gpu: 0, gpuMemUtil: 0.2 }] });
  const i1 = sim.instances[1];
  assert.equal(E.stretchNow(i1), 1);
  E.enqueue(sim, { prompt: 100, output: 400, model: 'llama-3.2-1b' });
  E.tick(sim, 1);
  assert.equal(E.stretchNow(i1), 1);
  E.enqueue(sim, { prompt: 6000, output: 50, model: 'llama-3-8b' });
  let seen = false;
  for (let t = 0; t < 2000 && !seen; t++) {
    E.tick(sim, 1);
    if (E.stretchNow(i1) === 2) seen = true;
  }
  assert.ok(seen);
});

// ---- Tab 04: the System1 hop, hidden difficulty and the routing threshold ----

const routePreset = () => E.PRESETS['routing-onprem'];
// The on-prem routing preset with its own settings merged over the preset's routing
function routingSim(over = {}, seed = 1, extra = {}) {
  const p = routePreset();
  return E.createSim(Object.assign({}, p, { seed, routing: Object.assign({}, p.routing, over) }, extra));
}
// The same with its stream quiet (rate 0, no bursts), so a test sends its own requests
const quietRouting = (over = {}, seed = 1) =>
  routingSim(over, seed, { streams: routePreset().streams.map(s => Object.assign({}, s, { rate: 0, bursts: false })) });

test('tab 04: a System1 model with Llama 3.2 1B\'s numbers, on 1g next to the 1B on 2g and the 8B on 3g of one H100', () => {
  const p = routePreset();
  assert.deepEqual(E.MODELS.system1, { label: 'System1 model', short: 'S1', params: 1.24e9, weightsGB: 2.47, kvBytesPerToken: 32768, contextLen: 131072 });
  assert.deepEqual(p.instances, [{ profile: '1g.10gb', model: 'system1', gpu: 0 }, { profile: '2g.20gb', model: 'llama-3.2-1b', gpu: 0 },
                                 { profile: '3g.40gb', model: 'llama-3-8b', gpu: 0 }]);
  assert.deepEqual(p.slo, { 'llama-3-8b': 2000, api: 2000, 'llama-3.2-1b': 1000 });
  assert.equal(p.streams.length, 1);
  assert.equal(p.streams[0].model, 'system1');
  assert.equal(p.streams[0].lengths, E.PRESETS['mig-mig'].streams[0].lengths);   // LENGTHS, the chat-like stand-in
  assert.deepEqual([p.routing.small, p.routing.large], ['llama-3.2-1b', 'llama-3-8b']);
  const sim = preset('routing-onprem', 1);
  assert.equal(sim.gpuCount, 1);
  assert.ok(sim.instances.every(i => i.fits && !i.timeSliced));
  assert.deepEqual(sim.routing, p.routing);
  assert.notEqual(sim.routing, p.routing);   // a copy, so moving the threshold leaves the preset alone
  assert.equal(routingSim({ threshold: 0.8 }).routing.threshold, 0.8);   // the page's override, kept across redeploys
  for (const id of ['batching', 'kvcache', 'mig-gpu', 'mig-time', 'mig-mig']) assert.equal(preset(id, 1).routing, null, id);
});
test('tab 04: the stream is more than the 8B alone serves on its 3g slice, so threshold 0 overloads it (seeds 1-3)', () => {
  const stream = routePreset().streams[0];
  for (const seed of [1, 2, 3]) {
    const sim = E.createSim({ seed, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], batching: 'continuous',
      streams: [Object.assign({}, stream, { model: 'llama-3-8b' })] });
    run(sim, 60000);
    const before = sim.stats.finished, backlog = sim.instances[0].queue.length;
    run(sim, 60000);
    // with requests waiting throughout, what it finishes over the minute is all it can serve
    assert.ok(backlog > 0 && sim.instances[0].queue.length > 0, `seed ${seed}: queue ${backlog}, ${sim.instances[0].queue.length}`);
    const served = (sim.stats.finished - before) / 60;
    assert.ok(served < stream.rate, `seed ${seed}: the 8B alone serves ${served.toFixed(2)} req/s of ${stream.rate}`);
  }
});
test('tab 04: TTFT runs from arrival to the answer\'s first token, so it includes the System1 hop', () => {
  const sim = quietRouting({ threshold: 0 });   // everything to the 8B
  const r = E.enqueue(sim, { prompt: 1000, output: 50 });
  assert.deepEqual([r.hop, r.inst, r.score, r.target, r.tScored], ['score', 0, null, null, null]);
  assert.ok(r.difficulty >= 0 && r.difficulty <= 1);
  run(sim, 5000);
  assert.equal(r.state, 'done');
  assert.deepEqual([r.hop, r.target, r.model, r.inst], ['serve', 'large', 'llama-3-8b', 2]);
  assert.equal(sim.stats.finished, 1);
  const alone = E.createSim({ seed: 1, instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }], traffic: { rate: 0, bursts: false } });
  const a = E.enqueue(alone, { prompt: 1000, output: 50 });
  run(alone, 5000);
  assert.ok(r.t0 < r.tScored && r.tScored < r.tFirst);
  near(r.tFirst - r.tScored, a.tFirst - a.t0, 1e-9);   // the serving hop starts the moment the score is out
  assert.ok(r.tFirst - r.t0 > a.tFirst - a.t0, `${r.tFirst - r.t0} vs ${a.tFirst - a.t0}`);
  assert.deepEqual(sim.ttftLog, [[r.tFirst, r.tFirst - r.t0, 'llama-3-8b']]);   // one entry, the answer's
});
test('tab 04: the System1 model\'s token is not an output token, so throughput counts only the answer\'s', () => {
  const sim = quietRouting({ threshold: 1 });   // everything to the 1B
  const r = E.enqueue(sim, { prompt: 500, output: 30 });
  run(sim, 3000);
  assert.equal(r.state, 'done');
  assert.equal(r.generated, 30);
  assert.equal(sim.tokLog.reduce((n, e) => n + e[1], 0), 30);
});
test('tab 04: at threshold 0 every request goes to the large model, at 1 every request to the small one', () => {
  for (const [threshold, target, model] of [[0, 'large', 'llama-3-8b'], [1, 'small', 'llama-3.2-1b']]) {
    const sim = routingSim({ threshold }, 2);
    run(sim, 20000);
    assert.ok(sim.finished.length > 50, String(sim.finished.length));
    assert.ok(sim.finished.every(r => r.target === target && r.model === model), String(threshold));
    assert.equal(target === 'large' ? sim.stats.routedLarge : sim.stats.routedSmall, sim.stats.routedSmall + sim.stats.routedLarge);
    assert.equal(E.metrics(sim).smallShare, threshold);
    assert.equal(E.metrics(sim).misroutedShare, threshold);   // hard requests: none sent small at 0, all at 1
  }
  // A score of 1 still goes small at threshold 1 (noise can push a score to 1; set by hand here)
  const sim = quietRouting({ threshold: 1, noise: 0 });
  const r = E.enqueue(sim, { prompt: 100, output: 2 });
  r.difficulty = 1;
  run(sim, 2000);
  assert.deepEqual([r.score, r.target, r.model, r.state], [1, 'small', 'llama-3.2-1b', 'done']);
});
// Sends n short requests through the router, one every 48 ms (about 21 req/s, well within every slice), then
// lets them finish
function routeMany(over, n = 400, seed = 1) {
  const sim = quietRouting(over, seed), reqs = [];
  for (let k = 0; k < n; k++) { reqs.push(E.enqueue(sim, { prompt: 200, output: 4 })); run(sim, 48); }
  run(sim, 10000);
  assert.equal(sim.stats.finished, n);
  return { sim, reqs };
}
test('tab 04: misrouted counts hard requests sent small: none with exact scores and the threshold at the hard cut, all at threshold 1', () => {
  const cut = routePreset().routing.hardCut;
  const exact = routeMany({ noise: 0, threshold: cut });
  const hard = exact.reqs.filter(r => r.difficulty >= cut).length;
  assert.ok(hard > 50 && hard < 350, String(hard));
  assert.ok(exact.reqs.every(r => r.score === r.difficulty));
  assert.equal(exact.sim.stats.misrouted, 0);
  assert.equal(exact.sim.stats.routedLarge, hard);
  assert.equal(E.metrics(exact.sim).misroutedShare, 0);
  near(E.metrics(exact.sim).smallShare, 1 - hard / 400, 1e-12);
  const all = routeMany({ noise: 0, threshold: 1 });
  assert.equal(all.sim.stats.misrouted, all.reqs.filter(r => r.difficulty >= cut).length);
  assert.equal(all.sim.stats.routedSmall, 400);
  assert.equal(E.metrics(all.sim).misroutedShare, 1);
  // both shares cover the last 30 s: once the routing decisions age out they have no value again
  run(all.sim, 31000);
  assert.deepEqual([E.metrics(all.sim).smallShare, E.metrics(all.sim).misroutedShare], [null, null]);
});
test('tab 04: small share and misrouted share are null outside tab 04 and before any request is routed', () => {
  const mig = preset('mig-mig', 1);
  run(mig, 5000);
  assert.deepEqual([E.metrics(mig).smallShare, E.metrics(mig).misroutedShare], [null, null]);
  assert.deepEqual([E.metrics(quietRouting()).smallShare, E.metrics(quietRouting()).misroutedShare], [null, null]);
  assert.throws(() => E.setThreshold(mig, 0.5), /routing/);
});
test('tab 04: 20-30% of requests are hard, and every difficulty is in [0, 1] (2000 arrivals, seeds 1-5)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const sim = quietRouting({}, seed);
    const d = Array.from({ length: 2000 }, () => E.enqueue(sim, { prompt: 100, output: 1 }).difficulty);
    assert.ok(d.every(x => x >= 0 && x <= 1));
    const share = d.filter(x => x >= routePreset().routing.hardCut).length / d.length;
    assert.ok(share >= 0.2 && share <= 0.3, `seed ${seed}: ${share}`);
  }
});
test('tab 04: the same seed gives the same difficulties and scores', () => {
  const scores = seed => { const sim = preset('routing-onprem', seed); run(sim, 20000); return sim.finished.map(r => [r.id, r.difficulty, r.score]); };
  const a = scores(3);
  assert.ok(a.length > 50);
  assert.ok(a.every(([, d, s]) => s >= 0 && s <= 1));
  assert.ok(a.some(([, d, s]) => s !== d), 'the score is noisy');
  assert.deepEqual(scores(3), a);
  assert.notDeepEqual(scores(4), a);
});
// Every request a test can see: in a queue or running list after a tick, or finished
function track(sim, seen) {
  for (const inst of sim.instances) for (const r of inst.queue.concat(inst.running)) seen.set(r.id, r);
  for (const r of sim.finished) seen.set(r.id, r);
}
test('tab 04: a threshold change applies to requests scored from then on, and nothing is lost or counted twice', () => {
  const sim = routingSim({}, 5, { streams: routePreset().streams.map(s => Object.assign({}, s, { rate: 8 })) });
  const seen = new Map(), changes = [0.2, 0.8, 0, 1, 0.45], set = [];
  run(sim, 60000, s => {
    track(s, seen);
    if (set.length < changes.length && s.t >= (set.length + 1) * 10000) {
      E.setThreshold(s, changes[set.length]);
      set.push([s.t, changes[set.length]]);
    }
  });
  assert.deepEqual(sim.events, set.map(([t, x]) => ({ t, label: 'threshold ' + x.toFixed(2) })));
  assert.equal(sim.routing.threshold, 0.45);
  E.setThreshold(sim, 0.45);
  assert.equal(sim.events.length, 5);   // unchanged: no new marker
  E.setArrivals(sim, false);
  while (!E.isDrained(sim) && sim.t < 400000) { E.tick(sim, 16); track(sim, seen); }
  assert.ok(E.isDrained(sim));
  assert.equal(sim.stats.arrived, sim.stats.finished + sim.stats.rejected);
  assert.equal(new Set(sim.finished.map(r => r.id)).size, sim.finished.length);
  const scored = [...seen.values()].filter(r => r.tScored !== null);
  assert.equal(scored.length, sim.stats.routedSmall + sim.stats.routedLarge);   // every routing decision, counted once
  // The threshold in force at a time: a change made between ticks applies to scores after it
  const inForce = t => set.reduce((x, [at, v]) => (at < t ? v : x), routePreset().routing.threshold);
  for (const r of scored) {
    const x = inForce(r.tScored);
    assert.equal(r.target, x < 1 && r.score >= x ? 'large' : 'small', `request ${r.id}: score ${r.score} at ${r.tScored} under ${x}`);
    assert.equal(r.model, r.target === 'large' ? 'llama-3-8b' : 'llama-3.2-1b');
  }
  assert.ok(scored.some(r => r.target === 'large') && scored.some(r => r.target === 'small'));
});
test('tab 04: a drain waits for requests between hops and finishes', () => {
  const sim = preset('routing-onprem', 6);
  run(sim, 20000);
  E.setArrivals(sim, false);
  E.sendBurst(sim, 30);   // a burst while paused, so the System1 model has a queue when the drain starts
  run(sim, 500);
  const [s1, ...serving] = sim.instances, held = i => i.queue.concat(i.running);
  assert.ok(held(s1).length > 0 && held(s1).every(r => r.hop === 'score'));
  assert.ok(serving.some(i => held(i).length > 0) && serving.every(i => held(i).every(r => r.hop === 'serve')));
  let onlyServing = false;
  while (!E.isDrained(sim) && sim.t < 200000) {
    E.tick(sim, 16);
    assert.equal(E.playState(sim, false), E.isDrained(sim) ? 'stopped' : 'draining');
    if (!held(s1).length && serving.some(i => held(i).length > 0)) onlyServing = true;
  }
  assert.ok(E.isDrained(sim));
  assert.ok(onlyServing, 'the System1 model emptied before the serving models');
  assert.equal(sim.stats.arrived, sim.stats.finished + sim.stats.rejected);
});

// ---- Tab 04: the API model ----

const apiPreset = () => E.PRESETS['routing-api'];
// The API routing preset with its own routing settings merged over the preset's, and its stream quiet (rate 0,
// no bursts) so a test sends its own requests
function quietApi(over = {}, seed = 1, extra = {}) {
  const p = apiPreset();
  return E.createSim(Object.assign({}, p, { seed, routing: Object.assign({}, p.routing, over),
    streams: p.streams.map(s => Object.assign({}, s, { rate: 0, bursts: false })) }, extra));
}
const logged = sim => sim.tokLog.reduce((n, e) => n + e[1], 0);

test('tab 04: the API model is an instance with no GPU, no KV and no queue, and routing-api puts it in the 8B\'s place', () => {
  assert.deepEqual(E.MODELS.api, { label: 'API model', short: 'API' });
  const on = E.PRESETS['routing-onprem'], p = apiPreset();
  assert.deepEqual(p.instances, [on.instances[0], on.instances[1], { profile: 'api', model: 'api' }]);
  assert.deepEqual(p.routing, Object.assign({}, on.routing, { large: 'api' }));
  for (const key of ['batching', 'slo', 'streams']) assert.deepEqual(p[key], on[key], key);
  const sim = preset('routing-api', 1), a = sim.instances[2];
  assert.deepEqual([a.api, a.fits, a.profile, a.model, a.kvBudget, a.kvUsed, a.timeSliced], [true, true, 'api', 'api', 0, 0, false]);
  assert.ok(sim.instances.slice(0, 2).every(i => i.api === false && i.fits));
  assert.deepEqual(sim.routing, p.routing);
  assert.equal(E.canAdmit(sim, a), false);   // the page draws no free-slot row for it
  assert.throws(() => E.createInstance('7g.80gb', 'api', {}), /API model/);
  assert.throws(() => E.createInstance('api', 'llama-3-8b', {}), /API model/);
  for (const key of ['inputPer1M', 'outputPer1M', 'baseMs', 'msPerInputToken', 'tpotMs']) assert.ok(E.API[key] > 0, key);
  assert.equal(E.API_SOURCE, E.API.source);
  assert.match(E.API_SOURCE, /https:\/\/\S+.*https:\/\/\S+/);   // a list price and a latency benchmark,
  assert.match(E.API_SOURCE, /checked 2026-10-26/);             // with the date they were checked
});
test('tab 04: an API request\'s first token comes a fixed base plus a time per input token after it enters, then one token every tpotMs, logged as made', () => {
  const sim = quietApi({ threshold: 0 }), A = E.API, ttft = A.baseMs + 1000 * A.msPerInputToken;   // everything to the API
  const r = E.enqueue(sim, { prompt: 1000, output: 50 });
  // the tokens made by time t: the first at tScored + ttft, then one every tpotMs, 50 in all
  const due = t => r.tScored === null || t < r.tScored + ttft ? 0 : Math.min(50, 1 + Math.floor((t - r.tScored - ttft) / A.tpotMs));
  let waited = false;
  run(sim, 5000, s => {
    const n = logged(s);
    assert.ok(n <= due(s.t + 1e-6) && n >= due(s.t - 100), `${n} tokens logged at ${s.t}, ${due(s.t)} made`);
    if (r.tScored !== null && r.tFirst === null) {   // between hops: the prefill bar fills over the first-token wait
      near(E.prefillProgress(s, s.instances[2], r), (s.t - r.tScored) / ttft, 1e-9);
      waited = true;
    }
  });
  assert.ok(waited);
  assert.equal(r.state, 'done');
  assert.deepEqual([r.target, r.model, r.inst, r.generated, r.kvTokens], ['large', 'api', 2, 50, 0]);
  near(r.tFirst - r.tScored, ttft, 1e-9);
  near(r.tDone - r.tFirst, 49 * A.tpotMs, 1e-9);
  assert.equal(E.prefillProgress(sim, sim.instances[2], r), 1);
  assert.deepEqual(sim.ttftLog, [[r.tFirst, r.tFirst - r.t0, 'api']]);   // its TTFT includes the System1 hop
  assert.equal(logged(sim), 50);
  assert.equal(sim.stats.finished, 1);
  near(E.metrics(sim, 'api').tpotMs, A.tpotMs, 1e-9);
  assert.deepEqual([sim.instances[2].queue.length, sim.instances[2].running.length], [0, 0]);
});
test('tab 04: API spend bills the prompt when a request enters and each output token as it is made', () => {
  const sim = quietApi({ threshold: 0 }), A = E.API;
  const r = E.enqueue(sim, { prompt: 1000, output: 50 });
  let entered = null;
  run(sim, 5000, s => { if (r.tScored !== null && entered === null) entered = [s.stats.apiUsd, r.generated]; });
  assert.ok(entered);
  assert.equal(entered[1], 0);                          // scored, at the API, no token yet: the prompt is billed
  near(entered[0], 1000 * A.inputPer1M / 1e6, 1e-15);
  assert.equal(r.state, 'done');
  near(sim.stats.apiUsd, 1000 * A.inputPer1M / 1e6 + 50 * A.outputPer1M / 1e6, 1e-15);
  // the System1 model and the small model cost no API spend
  const small = quietApi({ threshold: 1 });
  E.enqueue(small, { prompt: 1000, output: 50 });
  run(small, 5000);
  assert.deepEqual([small.stats.finished, small.stats.apiUsd], [1, 0]);
});
test('tab 04: the API model never queues or rejects: 500 requests at once at threshold 0 all run there together', () => {
  // The gateway's queue (the System1 model's) is raised to hold all 500, so every one reaches the API
  const sim = quietApi({ threshold: 0 }, 1, { config: { queueCap: 500 } }), A = E.API, a = sim.instances[2];
  const reqs = Array.from({ length: 500 }, () => E.enqueue(sim, { prompt: 16, output: 50 }));
  E.setArrivals(sim, false);
  let peak = 0;
  while (!E.isDrained(sim) && sim.t < 60000) {
    E.tick(sim, 16);
    assert.equal(a.queue.length, 0);
    peak = Math.max(peak, a.running.length);
  }
  assert.ok(E.isDrained(sim));
  assert.deepEqual([sim.stats.rejected, sim.stats.finished, sim.stats.routedLarge], [0, 500, 500]);
  assert.ok(peak >= 400, `at most ${peak} at once`);   // well past max-num-seqs (256): no concurrency limit
  for (const r of reqs) {   // the same fixed latency at any load
    assert.equal(r.model, 'api');
    near(r.tFirst - r.tScored, A.baseMs + 16 * A.msPerInputToken, 1e-9);
    near(r.tDone - r.tFirst, 49 * A.tpotMs, 1e-9);
  }
});
test('tab 04: the API instance is no GPU: one H100 in both modes, and KV use counts only the GPU instances', () => {
  for (const id of ['routing-onprem', 'routing-api']) assert.equal(preset(id, 1).gpuCount, 1, id);
  assert.equal(E.createSim({ seed: 1, streams: [{ model: 'llama-3-8b', rate: 0 }],
    instances: [{ profile: '7g.80gb', model: 'llama-3-8b' }, { profile: 'api', model: 'api', gpu: 1 }] }).gpuCount, 1);
  const sim = preset('routing-api', 2);
  run(sim, 20000);
  const gpus = sim.instances.filter(i => !i.api);
  const frac = gpus.reduce((n, i) => n + i.kvUsed, 0) / gpus.reduce((n, i) => n + i.kvBudget, 0);
  assert.ok(frac > 0 && sim.instances[2].running.length > 0);
  near(E.metrics(sim).kvFrac, frac, 1e-12);
  Object.assign(sim.instances[2], { kvUsed: 5e9, kvBudget: 10e9 });   // even an API instance holding KV wouldn't count
  near(E.metrics(sim).kvFrac, frac, 1e-12);
});
test('tab 04: cost per 1M output tokens blends the H100 and the API spend of the same 3 s as its tokens, and API $/h is the last 30 s of spend', () => {
  const sim = preset('routing-api', 1);
  let at30 = null;
  run(sim, 60000, s => { if (s.t === 30000) at30 = s.stats.apiUsd; });
  const m = E.metrics(sim);
  const last3s = sim.apiLog.filter(([t]) => t >= sim.t - 3000).reduce((n, [, usd]) => n + usd, 0);
  assert.ok(at30 > 0 && last3s > 0 && m.apiUsdPerHour > 0 && m.tokPerSec > 0);
  near(m.apiUsdPerHour, (sim.stats.apiUsd - at30) * 3600 / 30, 1e-9);
  near(m.costPer1M, (E.GPU_HOUR_USD * sim.gpuCount / 3600 + last3s / 3) / m.tokPerSec * 1e6, 1e-9);
  // on-prem there is no API: no API $/h, and cost is the H100's alone
  const onprem = preset('routing-onprem', 1);
  run(onprem, 20000);
  const o = E.metrics(onprem);
  assert.equal(o.apiUsdPerHour, null);
  near(o.costPer1M, E.GPU_HOUR_USD / 3600 / o.tokPerSec * 1e6, 1e-9);
  assert.equal(E.metrics(preset('batching', 1)).apiUsdPerHour, null);
  // drained, nothing is being spent: 0, like throughput
  E.setArrivals(sim, false);
  while (!E.isDrained(sim) && sim.t < 200000) E.tick(sim, 16);
  assert.ok(E.isDrained(sim));
  assert.deepEqual([E.metrics(sim).apiUsdPerHour, E.metrics(sim).costPer1M], [0, null]);
});
test('tab 04: draining in API mode, cost never jumps above its running level, and once the API has had nothing in flight for 3 s it is the H100 alone', () => {
  for (const seed of [1, 2, 3]) {
    const sim = preset('routing-api', seed);
    run(sim, 60000);
    const steady = E.metrics(sim).costPer1M;
    E.setArrivals(sim, false);
    let peak = 0, idleSince = null, checked = false;
    while (!E.isDrained(sim) && sim.t < 200000) {
      E.tick(sim, 16);
      const m = E.metrics(sim), api = sim.instances.find(i => i.api);
      if (m.costPer1M !== null) peak = Math.max(peak, m.costPer1M);
      if (api.running.length) idleSince = null;
      else if (idleSince === null) idleSince = sim.t;
      if (idleSince !== null && sim.t - idleSince > 3000 && m.tokPerSec > 0) {
        near(m.costPer1M, E.GPU_HOUR_USD * sim.gpuCount / 3600 / m.tokPerSec * 1e6, 1e-9);
        checked = true;
      }
    }
    // the H100 is still billed while its slices drain, so cost rises a little, but nothing like 30 s of API spend over 3 s of tokens
    assert.ok(peak < steady * 4, `seed ${seed}: peak $${peak.toFixed(2)} vs steady $${steady.toFixed(2)}`);
    assert.ok(checked || E.isDrained(sim), `seed ${seed}`);
  }
});
// The run whose small share after 60 s is closest to 0.75, from a bisection on the threshold. A seed's scores
// and the times they're made don't depend on the threshold, so the small share only grows with it.
function split75(seed) {
  let lo = 0, hi = 1, best = null;
  for (let k = 0; k < 12; k++) {
    const x = (lo + hi) / 2, sim = E.createSim(Object.assign({}, apiPreset(), { seed, routing: Object.assign({}, apiPreset().routing, { threshold: x }) }));
    run(sim, 60000);
    const m = E.metrics(sim);
    if (!best || Math.abs(m.smallShare - 0.75) < Math.abs(best.m.smallShare - 0.75)) best = { x, sim, m };
    if (Math.abs(m.smallShare - 0.75) <= 0.01) break;
    if (m.smallShare < 0.75) lo = x;
    else hi = x;
  }
  return best;
}
test('tab 04: at a 75/25 small/large split the API bill is at least 70% of the blended cost (seeds 1-5, 60 s)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { x, sim, m } = split75(seed);
    assert.ok(m.smallShare >= 0.7 && m.smallShare <= 0.8, `seed ${seed}: small share ${m.smallShare} at threshold ${x}`);
    const gpu = E.GPU_HOUR_USD * sim.gpuCount / 3600, api = m.apiUsdPerHour / 3600;
    assert.ok(api / (gpu + api) >= 0.7, `seed ${seed}: the API is ${(100 * api / (gpu + api)).toFixed(1)}% of the blended cost`);
  }
});

// ---- Tab 04 as a visitor sees it ----

// The page warms up every preset with an slo for TAB03_WARMUP_TICKS (PAGE.tab03WarmMs, 40 s), tab 04's too, so a
// load opens on a full 30 s p99 window; then the footer and the boxes refresh every 300 ms. A box is red when its
// model's TTFT p99 over P99_WINDOW_MS is over its target in sim.slo, and green when it's within it. Only the
// models with both a target and an instance have a coloured box: the System1 box has no target, on-prem has no API
// and the API mode no 8B.
// A visitor reaches a threshold in one of two ways. Opening the tab deploys at the default, and the slider then
// moves the threshold live (E.setThreshold, no redeploy): routeMove. A load deployed at another threshold only
// comes from a mode switch with the slider already moved, since deploy keeps it: routeVisit.
const ROUTE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];   // the page draws a random seed, so the lesson must not hang on one
const routeVisits = {};
// One load of a tab 04 deployment with the slider at threshold: per refresh, its time, whether each box is red,
// whether every box is green, and the footer's metrics
function routeVisit(id, threshold, seed, watchMs = 30000) {
  const key = [id, threshold, seed, watchMs].join('/');
  if (routeVisits[key]) return routeVisits[key];
  const p = E.PRESETS[id];
  const sim = E.createSim(Object.assign({}, p, { seed, routing: Object.assign({}, p.routing, { threshold }) }));
  const boxes = Object.keys(sim.slo).filter(model => sim.instances.some(i => i.model === model));
  const refreshes = [];
  visit(sim, PAGE.tab03WarmMs, watchMs, s => {
    const p99 = boxes.map(model => E.metrics(s, model, PAGE.p99WindowMs).ttftP99);
    refreshes.push({
      t: s.t,
      red: p99.map((v, i) => v !== null && v > s.slo[boxes[i]]),
      green: p99.every((v, i) => v !== null && v <= s.slo[boxes[i]]),
      m: E.metrics(s)
    });
  });
  return (routeVisits[key] = { boxes, refreshes });
}
// One load on-prem opened at the default, with the slider moved to `to` at the open: per refresh from the open on,
// the time since the move, whether the 8B box is red, and the 503s so far
function routeMove(to, seed, watchMs) {
  const sim = E.createSim(Object.assign({}, E.PRESETS['routing-onprem'], { seed }));
  const refreshes = [];
  let moved = null;
  visit(sim, PAGE.tab03WarmMs, watchMs, s => {
    if (moved === null) { moved = s.t; E.setThreshold(s, to); }
    const p99 = E.metrics(s, 'llama-3-8b', PAGE.p99WindowMs).ttftP99;
    refreshes.push({ after: s.t - moved, red: p99 !== null && p99 > s.slo['llama-3-8b'], rejected: s.stats.rejected });
  });
  return refreshes;
}
const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
const greenShare = refreshes => refreshes.filter(r => r.green).length / refreshes.length;
// The mean of what the footer shows for a metric over a load's refreshes, leaving out the ones that show '–' (null;
// NaN, so the test fails, if every one does)
const shown = (refreshes, key) => mean(refreshes.map(r => r.m[key]).filter(v => v !== null));
const fixed = (list, digits = 2) => list.map(v => v.toFixed(digits)).join(' ');
const defaultThreshold = () => E.PRESETS['routing-onprem'].routing.threshold;

test('tab 04 as a visitor sees it: the default threshold is on the slider\'s 0.05 steps, the same in both modes', () => {
  const x = defaultThreshold();
  near(Math.round(x / 0.05) * 0.05, x, 1e-12);
  assert.ok(x > 0 && x < 1);
  assert.equal(E.PRESETS['routing-api'].routing.threshold, x);
  assert.deepEqual(routeVisit('routing-onprem', x, 1).boxes, ['llama-3-8b', 'llama-3.2-1b']);
  assert.deepEqual(routeVisit('routing-api', x, 1).boxes, ['api', 'llama-3.2-1b']);
});
test('tab 04 as a visitor sees it: moving the slider from the default to 0 on-prem turns the 8B box red within 20 s on 9 of 10 loads, and 503s start within 2 min on 8 of 10', () => {
  const loads = ROUTE_SEEDS.map(seed => routeMove(0, seed, 120000));
  const after = (refreshes, f) => { const r = refreshes.find(x => x.after > 0 && f(x)); return r ? r.after : Infinity; };
  const toRed = loads.map(refreshes => after(refreshes, x => x.red));
  const to503 = loads.map(refreshes => after(refreshes, x => x.rejected > refreshes[0].rejected));
  const secs = list => list.map(v => (v / 1000).toFixed(1)).join(' ');
  assert.ok(toRed.filter(v => v <= 20000).length >= 9, `the 8B turned red after (s) ${secs(toRed)}`);
  assert.ok(to503.filter(v => v <= 120000).length >= 8, `the first 503 after (s) ${secs(to503)}`);
});
test('tab 04, a load deployed at threshold 0 on-prem (a mode switch with the slider at 0): the 8B box is red on 70% of refreshes in its first 30 s (median over loads), and 503s keep coming within 2 min on 8 of 10', () => {
  const loads = ROUTE_SEEDS.map(seed => routeVisit('routing-onprem', 0, seed, 120000));
  const large = loads[0].boxes.indexOf('llama-3-8b');
  const shares = loads.map(({ refreshes }) => redShare(refreshes.filter(r => r.t <= refreshes[0].t + 30000).map(r => r.red[large])));
  assert.ok(median(shares) >= 0.7, `median ${median(shares)}; per load ${fixed(shares)}`);
  const rejected = loads.map(({ refreshes }) => [refreshes[0].m.rejected, refreshes[refreshes.length - 1].m.rejected]);
  const growing = rejected.filter(([open, end]) => end > open).length;
  assert.ok(growing >= 8, `503s grew on ${growing}/10 loads (at the open, 2 min later: ${rejected.map(r => r.join('/')).join(' ')})`);
});
test('tab 04 as a visitor sees it: at the default threshold on-prem every box is green on 95% of refreshes and at most 5% of hard requests are misrouted (median over loads)', () => {
  const loads = ROUTE_SEEDS.map(seed => routeVisit('routing-onprem', defaultThreshold(), seed));
  const green = loads.map(({ refreshes }) => greenShare(refreshes)), mis = loads.map(({ refreshes }) => shown(refreshes, 'misroutedShare'));
  assert.ok(median(green) >= 0.95, `median ${median(green)}; per load ${fixed(green)}`);
  assert.ok(median(mis) <= 0.05, `median ${median(mis)}; per load ${fixed(mis, 3)}`);
});
test('tab 04, a load deployed at threshold 1 on-prem: at least half the hard requests are misrouted (median over loads)', () => {
  const mis = ROUTE_SEEDS.map(seed => shown(routeVisit('routing-onprem', 1, seed).refreshes, 'misroutedShare'));
  assert.ok(median(mis) >= 0.5, `median ${median(mis)}; per load ${fixed(mis, 3)}`);
});
test('tab 04: on-prem, cost per 1M output tokens is lower at the default threshold than at 0, since the same H100 serves more (median over seeds, at 60 s)', () => {
  const cost = threshold => ROUTE_SEEDS.map(seed => {
    const sim = routingSim({ threshold }, seed);
    run(sim, 60000);
    return E.metrics(sim).costPer1M;
  });
  const at0 = cost(0), atDefault = cost(defaultThreshold());
  assert.ok(median(atDefault) < median(at0), `$${median(atDefault)} vs $${median(at0)}; per seed ${fixed(atDefault)} vs ${fixed(at0)}`);
});
test('tab 04, loads deployed in API mode at threshold 0, the default and 0.9: API $/h falls in that order (median over loads), and every box is green on 95% of refreshes at the default', () => {
  const thresholds = [0, defaultThreshold(), 0.9];
  const usd = thresholds.map(x => ROUTE_SEEDS.map(seed => shown(routeVisit('routing-api', x, seed).refreshes, 'apiUsdPerHour')));
  const medians = usd.map(median);
  assert.ok(medians[0] > medians[1] && medians[1] > medians[2], `API $/h ${fixed(medians, 1)} at ${thresholds.join(', ')}`);
  const green = ROUTE_SEEDS.map(seed => greenShare(routeVisit('routing-api', defaultThreshold(), seed).refreshes));
  assert.ok(median(green) >= 0.95, `median ${median(green)}; per load ${fixed(green)}`);
});

// ---- Tab 05: real traffic ----

const D = require('../assets/sim/azure-conv.json');
const TINY = { gapMs: [100, 200, 300], prompt: [10, 20, 30], output: [1, 2, 3], durationMs: 1000, speed: 2, fit: E.TRACE_FIT };
function traceSim(data, startMs, seed = 1) {
  const p = E.tracePreset(data);
  return E.createSim(Object.assign({}, p, { seed, streams: [Object.assign({}, p.streams[0], startMs === undefined ? {} : { startMs })] }));
}
// Every request the sim has seen, by id: queued, running or finished
function seen(sim) {
  const all = {};
  for (const inst of sim.instances) for (const r of inst.queue.concat(inst.running)) all[r.id] = r;
  for (const r of sim.finished) all[r.id] = r;
  return Object.values(all).sort((a, b) => a.id - b.id);
}
// Runs exactly ms of sim time in ticks of at most 50 ms
function runExact(sim, ms) {
  const end = sim.t + ms;
  while (sim.t < end) E.tick(sim, Math.min(50, end - sim.t));
}
// Absolute hour times of the real trace's requests (one loop)
const TRACE_T = D.gapMs.reduce((a, g) => (a.push((a.length ? a[a.length - 1] : 0) + g), a), []);

test('tab 05: a trace stream replays each request at its time, with its own lengths', () => {
  const sim = traceSim(TINY, 0);
  runExact(sim, 400);
  assert.deepEqual(seen(sim).map(r => [r.t0, r.prompt, r.output]), [[50, 10, 1], [150, 20, 2], [300, 30, 3]]);
});
test('tab 05: the replay loops, and the sparkline marks it', () => {
  const sim = traceSim(TINY, 0);
  runExact(sim, 540);
  assert.equal(sim.stats.arrived, 3);
  assert.equal(sim.events.filter(e => e.label === 'trace loops').length, 0);
  runExact(sim, 60);
  const fourth = seen(sim)[3];
  assert.deepEqual([fourth.t0, fourth.prompt, fourth.output], [550, 10, 1]);   // (1000 + 100) / 2
  assert.deepEqual(sim.events.filter(e => e.label === 'trace loops').map(e => e.t), [550]);
  assert.equal(E.traceClock(sim).ms, 200);   // hour time 1100 + 50 * 2 = 1200, so 200 into the second loop
});
test('tab 05: one loop of the real trace replays every sampled request', () => {
  const sim = traceSim(D, 0);
  runExact(sim, D.durationMs / D.speed - 1);
  assert.equal(sim.stats.arrived, D.kept);
});
test('tab 05: traceClock reads the hour\'s position, and is null outside tab 05', () => {
  const sim = traceSim(D);
  assert.deepEqual(E.traceClock(sim), { ms: E.TRACE_START_MS, totalMs: D.durationMs });
  runExact(sim, 1000);
  assert.equal(E.traceClock(sim).ms, E.TRACE_START_MS + 12000);
  assert.equal(E.traceClock(E.createSim(Object.assign({}, E.PRESETS.batching, { seed: 1 }))), null);
  assert.equal(E.traceClock(E.createSim(Object.assign({}, E.PRESETS['traffic-random'], { seed: 1 }))), null);
});
test('tab 05: pause freezes the hour and play resumes it, with no catch-up flood', () => {
  const sim = traceSim(D);
  runExact(sim, 5000);
  E.setArrivals(sim, false);
  const frozen = E.traceClock(sim).ms, arrived = sim.stats.arrived;
  runExact(sim, 10000);
  assert.deepEqual([E.traceClock(sim).ms, sim.stats.arrived], [frozen, arrived]);
  E.setArrivals(sim, true);
  runExact(sim, 1000);
  const due = TRACE_T.filter(t => t > frozen && t <= frozen + 12000).length;
  assert.ok(due > 0);
  assert.equal(sim.stats.arrived - arrived, due);
});
test('tab 05: a long tick advances the hour by at most 50 ms of sim time', () => {
  const sim = traceSim(D);
  const before = E.traceClock(sim).ms;
  E.tick(sim, 60000);
  assert.ok(E.traceClock(sim).ms - before <= 50 * 12);
});
test('tab 05: a burst on the trace stream draws the trace\'s fitted lengths', () => {
  // a fit that can only give one prompt and one output length, so any other source of lengths shows
  const ONE = Object.assign({}, TINY, { fit: { prompt: { median: 77, sigma: 0, min: 77, max: 77 }, output: { median: 5, sigma: 0, min: 5, max: 5 } } });
  const sim = traceSim(ONE, 0);
  E.setArrivals(sim, false);
  E.sendBurst(sim, 20, 0);
  runExact(sim, 1000);
  const burst = seen(sim);
  assert.equal(sim.stats.arrived, 20);
  assert.deepEqual([...new Set(burst.map(r => r.prompt + '/' + r.output))], ['77/5']);
});
test('tab 05: the random preset carries the trace\'s load', () => {
  assert.equal(E.TRACE_RATE, D.rate);
  assert.deepEqual(E.TRACE_FIT, { prompt: D.fit.prompt, output: D.fit.output });
  const s = E.PRESETS['traffic-random'].streams[0];
  assert.deepEqual([s.model, s.rate, s.bursts, s.lengths], ['llama-3-8b', E.TRACE_RATE, false, E.TRACE_FIT]);
  assert.deepEqual(E.PRESETS['traffic-random'].instances, E.tracePreset(D).instances);
});
test('tab 05: a trace stream rejects malformed data', () => {
  const bad = over => () => traceSim(Object.assign({}, TINY, over), 0);
  assert.throws(bad({ prompt: [10, 20] }), /^Error: bad trace/);
  assert.throws(bad({ gapMs: [], prompt: [], output: [] }), /^Error: bad trace/);
  assert.throws(bad({ speed: 0 }), /^Error: bad trace/);
});
// Tab 05 as the page shows it: the 40 s warm-up (it has an slo), then per refresh the time since the open,
// whether the box is red, and the 503s since the open
function trafficVisit(sim, watchMs) {
  const refreshes = [];
  let open = null, rejected = null;
  visit(sim, PAGE.tab03WarmMs, watchMs, s => {
    if (open === null) { open = s.t; rejected = s.stats.rejected; }
    const p99 = E.metrics(s, 'llama-3-8b', PAGE.p99WindowMs).ttftP99;
    refreshes.push({ at: s.t - open, red: p99 !== null && p99 > s.slo['llama-3-8b'], rejected: s.stats.rejected - rejected });
  });
  return refreshes;
}
test('tab 05 as a visitor sees it, on the trace: green at the open, red 10-25 s later, then back to green', () => {
  const r = trafficVisit(traceSim(D), 240000);
  const firstRed = r.find(x => x.red), early = r.filter(x => x.at < 120000), late = r.filter(x => x.at >= 120000);
  assert.equal(r[0].red, false, 'red at the open');
  assert.ok(firstRed && firstRed.at >= 10000 && firstRed.at <= 25000, `first red at ${firstRed && firstRed.at} ms`);
  const share = early.filter(x => x.red).length / early.length;
  assert.ok(share >= 0.3, `red on ${share} of the first 2 min`);
  assert.ok(early[early.length - 1].rejected > 0, 'no 503 in the first 2 min');
  assert.ok(late.every(x => !x.red), `red at ${late.filter(x => x.red).map(x => x.at).join(', ')} ms`);
});
test('tab 05 as a visitor sees it, random traffic at the same load stays green', () => {
  const loads = Array.from({ length: 10 }, (_, k) => trafficVisit(E.createSim(Object.assign({}, E.PRESETS['traffic-random'], { seed: k + 1 })), 120000));
  const green = loads.map(r => r.filter(x => !x.red).length / r.length), clean = loads.filter(r => r[r.length - 1].rejected === 0).length;
  assert.ok(green.filter(g => g >= 0.95).length >= 9, `green share per load ${green.map(g => g.toFixed(2)).join(' ')}`);
  assert.ok(clean >= 9, `${clean}/10 loads without a 503`);
});

// ---- Tab 06: failure ----

function failSim(seed = 1, over = {}) { return E.createSim(Object.assign({}, E.PRESETS.failure, { seed }, over)); }
const status = (sim, k) => E.instanceStatus(sim, sim.instances[k]);

test('tab 06: killing a GPU retries its requests on the survivor', () => {
  const sim = failSim();
  runExact(sim, 20000);
  const dead = sim.instances[1].running.concat(sim.instances[1].queue).map(r => [r, r.id, r.t0]);
  assert.ok(dead.length > 0);
  assert.equal(E.killGpu(sim), 1);
  assert.equal(status(sim, 1).state, 'down');
  assert.deepEqual([sim.instances[1].queue.length, sim.instances[1].running.length], [0, 0]);
  for (const [r, id, t0] of dead) {
    assert.deepEqual([r.id, r.t0, r.retries], [id, t0, 1]);
    assert.ok(r.state === 'rejected' || (r.inst === 0 && r.prefillDone === 0 && r.generated === 0 && r.tFirst === null), `request ${id}: ${r.state} on ${r.inst}`);
  }
  assert.equal(sim.stats.retried, dead.length);
  assert.equal(sim.events[sim.events.length - 1].label, 'H100 2 killed');
});
test('tab 06: a kill cancels the step in flight', () => {
  const sim = failSim();
  runExact(sim, 20000);
  const doomed = sim.instances[1].stepEnd, retried = sim.instances[1].running.concat(sim.instances[1].queue);
  assert.ok(sim.instances[1].running.length > 0 && doomed !== null && doomed > sim.t);
  E.killGpu(sim);
  const at = sim.t, end = sim.t + 5000;
  while (sim.t < end) {
    E.tick(sim, 16);
    const dead = sim.instances[1];
    assert.deepEqual([dead.running.length, dead.queue.length, dead.kvUsed], [0, 0, 0]);
    for (const inst of sim.instances) for (const r of inst.queue.concat(inst.running)) assert.notEqual(r.inst, 1);
    // the cancelled step never completes: nothing is logged at its end, and a retry still waiting has made nothing
    assert.ok(!sim.ttftLog.some(e => e[0] === doomed) && !sim.tokLog.some(e => e[0] === doomed), 'logged at the dead step\'s end');
    for (const r of retried) if (r.state === 'queued') assert.deepEqual([r.prefillDone, r.generated, r.tFirst], [0, 0, null]);
  }
  assert.ok(sim.finished.filter(r => r.tDone > at).every(r => r.inst === 0));
});
test('tab 06: the footer\'s KV share counts only GPUs that are up', () => {
  const sim = failSim();
  runExact(sim, 20000);
  E.killGpu(sim);
  runExact(sim, 10000);
  const live = sim.instances[0];
  near(E.metrics(sim).kvFrac, live.kvUsed / live.kvBudget, 1e-12);
  E.setAutoscaler(sim, true);
  near(E.metrics(sim).kvFrac, live.kvUsed / live.kvBudget, 1e-12);   // a starting GPU holds no cache yet either
});
test('tab 06: the kill button has nothing to kill with one GPU left', () => {
  const sim = failSim();
  runExact(sim, 5000);
  E.killGpu(sim);
  const retried = sim.stats.retried, events = sim.events.length;
  assert.equal(E.killGpu(sim), null);
  assert.deepEqual([status(sim, 0).state, sim.stats.retried, sim.events.length], ['up', retried, events]);
});
test('tab 06: billing follows the GPUs', () => {
  const sim = failSim();
  assert.equal(sim.gpuCount, 2);
  E.killGpu(sim);
  assert.equal(sim.gpuCount, 1);
  E.setAutoscaler(sim, true);
  assert.equal(sim.gpuCount, 2);
  runExact(sim, E.COLD_START_MS + 100);
  assert.equal(sim.gpuCount, 2);
});
test('tab 06: the autoscaler brings a replacement up after the cold start', () => {
  const sim = failSim();
  runExact(sim, 5000);
  E.killGpu(sim);
  E.setAutoscaler(sim, true);
  assert.deepEqual(status(sim, 1), { state: 'starting', gpu: 2, readyInMs: E.COLD_START_MS });
  runExact(sim, 10000);
  assert.equal(status(sim, 1).readyInMs, E.COLD_START_MS - 10000);
  runExact(sim, E.COLD_START_MS - 10000);
  assert.deepEqual(status(sim, 1), { state: 'up', gpu: 2, readyInMs: null });
  runExact(sim, 1000);
  assert.ok(sim.instances[1].running.length + sim.instances[1].queue.length > 0, 'the router sends it requests');
  const labels = sim.events.map(e => e.label);
  assert.ok(labels.includes('autoscaler on') && labels.includes('H100 3 starting') && labels.includes('H100 3 up'), labels.join(', '));
});
test('tab 06: autoscaler off cancels a start', () => {
  const sim = failSim();
  E.killGpu(sim);
  E.setAutoscaler(sim, true);
  runExact(sim, 10000);
  E.setAutoscaler(sim, false);
  assert.deepEqual([status(sim, 1).state, status(sim, 1).gpu, sim.gpuCount], ['down', 1, 1]);
  assert.equal(sim.events[sim.events.length - 1].label, 'autoscaler off');
  E.setAutoscaler(sim, true);
  assert.equal(status(sim, 1).readyInMs, E.COLD_START_MS);
});
test('tab 06: GPU ids count up', () => {
  const sim = failSim(1, { autoscaler: true });
  E.killGpu(sim);
  runExact(sim, E.COLD_START_MS + 1000);
  assert.equal(status(sim, 1).gpu, 2);
  assert.equal(E.killGpu(sim), 2);
  assert.equal(sim.events.filter(e => e.label === 'H100 3 killed').length, 1);
  assert.deepEqual([status(sim, 1).state, status(sim, 1).gpu], ['starting', 3]);
});
test('tab 06: retries drain while paused', () => {
  const sim = failSim();
  runExact(sim, 20000);
  E.setArrivals(sim, false);
  const dead = sim.instances[1].running.concat(sim.instances[1].queue);
  E.killGpu(sim);
  const end = sim.t + 120000;
  while (!E.isDrained(sim) && sim.t < end) E.tick(sim, 50);
  assert.ok(E.isDrained(sim));
  assert.ok(dead.every(r => r.state === 'done' || r.state === 'rejected'), dead.map(r => r.state).join(' '));
});
test('tab 06: a replacement still starting keeps the sim awake', () => {
  const sim = failSim(1, { autoscaler: true });
  E.setArrivals(sim, false);
  E.killGpu(sim);
  runExact(sim, 20000);
  assert.equal(E.isDrained(sim), false);
  runExact(sim, E.COLD_START_MS);
  assert.ok(E.isDrained(sim));
});
test('tab 06: tabs 01–05 never see the lifecycle', () => {
  for (const id of Object.keys(E.PRESETS).filter(id => id !== 'failure')) {
    const sim = E.createSim(Object.assign({}, E.PRESETS[id], { seed: 1 }));
    assert.ok(sim.instances.every(inst => E.instanceStatus(sim, inst).state === 'up'), id);
    assert.equal(sim.autoscaler, false, id);
  }
});
// Tab 06 as the page shows it: the 40 s warm-up, an optional kill at the open, then per refresh the time since
// the open, whether a box is red (one model on two boxes, so the model's p99 is both boxes' colour) and the 503s
function failVisit(seed, { kill = false, autoscaler = false, watchMs = 30000 } = {}) {
  const sim = failSim(seed, { autoscaler });
  const refreshes = [];
  let open = null;
  visit(sim, PAGE.tab03WarmMs, watchMs, s => {
    if (open === null) { open = s.t; if (kill) E.killGpu(s); }
    const p99 = E.metrics(s, 'llama-3-8b', PAGE.p99WindowMs).ttftP99;
    refreshes.push({ at: s.t - open, red: p99 !== null && p99 > s.slo['llama-3-8b'], rejected: s.stats.rejected });
  });
  return refreshes;
}
const FAIL_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
test('tab 06 as a visitor sees it: green before the kill', () => {
  const green = FAIL_SEEDS.map(seed => { const r = failVisit(seed); return r.filter(x => !x.red).length / r.length; });
  assert.ok(green.filter(g => g >= 0.95).length >= 9, `green share per load ${green.map(g => g.toFixed(2)).join(' ')}`);
});
test('tab 06 as a visitor sees it: a kill turns it red and, with the autoscaler off, the 503s keep coming', () => {
  const loads = FAIL_SEEDS.map(seed => failVisit(seed, { kill: true, watchMs: 60000 }));
  const redSoon = loads.filter(r => r.some(x => x.red && x.at <= 15000)).length;
  const rejectedAt = (r, at) => r.filter(x => x.at <= at).pop().rejected;
  const growing = loads.filter(r => rejectedAt(r, 60000) > rejectedAt(r, 30000)).length;
  assert.ok(redSoon >= 9, `red within 15 s on ${redSoon}/10`);
  assert.ok(growing >= 9, `503s still growing on ${growing}/10`);
});
test('tab 06 as a visitor sees it: with the autoscaler on, the replacement brings it back', () => {
  const from = E.COLD_START_MS + 20000, to = E.COLD_START_MS + 60000;
  const loads = FAIL_SEEDS.map(seed => failVisit(seed, { kill: true, autoscaler: true, watchMs: to }).filter(x => x.at >= from));
  const green = loads.filter(r => r.every(x => !x.red)).length, quiet = loads.filter(r => r[r.length - 1].rejected === r[0].rejected).length;
  assert.ok(green >= 9, `green from ${from / 1000} s on ${green}/10`);
  assert.ok(quiet >= 9, `no new 503 on ${quiet}/10`);
});

// ---- Following a request, and the server config ----

// Every request a sim has seen, queued, running, finished or rejected: collect them as they arrive
function watchAll(sim) {
  const all = {};
  const grab = () => { for (const inst of sim.instances) for (const r of inst.queue.concat(inst.running)) all[r.id] = r; for (const r of sim.finished) all[r.id] = r; };
  return { tick(ms) { const end = sim.t + ms; while (sim.t < end) { E.tick(sim, Math.min(16, end - sim.t)); grab(); } }, all };
}
const kinds = r => r.spans.map(s => s.kind).join(' ');
test('follow: a finished request\'s spans run queue, prefill, decode, edge to edge from arrival to done', () => {
  const sim = E.createSim(Object.assign({}, E.PRESETS.batching, { seed: 3 })), w = watchAll(sim);
  w.tick(20000);
  const done = Object.values(w.all).filter(r => r.tDone !== null && r.preemptions === 0);
  assert.ok(done.length > 50);
  for (const r of done) {
    assert.equal(kinds(r), 'queue prefill decode', `#${r.id}`);
    const [q, p, d] = r.spans;
    assert.deepEqual([q.t0, q.t1, p.t1, d.t1], [r.t0, r.tAdmit, r.tFirst, r.tDone], `#${r.id}`);
    assert.deepEqual([p.t0, d.t0], [q.t1, p.t1], `#${r.id}`);
    assert.ok(r.spans.every(s => s.inst === 0));
  }
});
test('follow: a preempted request goes back to the queue, marked, and redoes its prefill', () => {
  const sim = E.createSim(Object.assign({}, E.PRESETS.kvcache, { seed: 1, config: { gpuMemUtil: 0.5 } })), w = watchAll(sim);
  w.tick(60000);
  const pre = Object.values(w.all).filter(r => r.preemptions > 0 && r.tDone !== null);
  assert.ok(pre.length > 0);
  for (const r of pre) {
    const marks = r.marks.filter(m => m.kind === 'preempted');
    assert.equal(marks.length, r.preemptions, `#${r.id}`);
    for (const m of marks) {
      const i = r.spans.findIndex(s => s.t0 === m.t && s.kind === 'queue');
      assert.ok(i > 0, `#${r.id}: no queue span starts at the preemption`);
      assert.equal(r.spans[i - 1].t1, m.t);
      assert.equal(r.spans[i + 1].kind, 'prefill');
    }
    for (let i = 1; i < r.spans.length; i++) assert.equal(r.spans[i].t0, r.spans[i - 1].t1, `#${r.id}: a gap`);
  }
});
test('follow: a scored request shows its System1 hop, its score and its serving hop', () => {
  const sim = E.createSim(Object.assign({}, E.PRESETS['routing-onprem'], { seed: 1 })), w = watchAll(sim);
  w.tick(20000);
  const r = Object.values(w.all).find(x => x.tDone !== null && x.preemptions === 0);
  assert.equal(kinds(r), 'queue prefill queue prefill decode');
  assert.equal(r.spans[0].inst, 0);   // the System1 model
  const scored = r.marks.find(m => m.kind === 'scored');
  assert.deepEqual([scored.t, scored.score, scored.target], [r.tScored, r.score, r.target]);
  assert.equal(r.spans[2].t0, r.tScored);
  assert.notEqual(r.spans[2].inst, 0);
});
test('follow: a request retried off a dead GPU is marked and starts over on the survivor', () => {
  const sim = failSim(1), w = watchAll(sim);
  w.tick(20000);
  const victims = sim.instances[1].running.slice();
  E.killGpu(sim);
  w.tick(30000);
  const r = victims.find(x => x.tDone !== null);
  const m = r.marks.find(x => x.kind === 'retried');
  assert.ok(m);
  const i = r.spans.findIndex(s => s.t0 === m.t);
  assert.deepEqual([r.spans[i - 1].t1, r.spans[i].kind, r.spans[i].inst], [m.t, 'queue', 0]);
});
test('follow: an API request waits for its first token, then decodes', () => {
  const sim = E.createSim(Object.assign({}, E.PRESETS['routing-api'], { seed: 1, routing: Object.assign({}, E.PRESETS['routing-api'].routing, { threshold: 0 }) })), w = watchAll(sim);
  w.tick(20000);
  const r = Object.values(w.all).find(x => x.tDone !== null && sim.instances[x.inst].api);
  assert.equal(kinds(r), 'queue prefill queue prefill decode');
  const [, , q, p, d] = r.spans;
  assert.equal(q.t1, q.t0);                  // an API request never queues
  assert.deepEqual([p.t1, d.t1], [r.tFirst, r.tDone]);
});
test('follow: requestSummary gives the strip its numbers', () => {
  const sim = E.createSim(Object.assign({}, E.PRESETS.batching, { seed: 3 })), w = watchAll(sim);
  w.tick(20000);
  const r = Object.values(w.all).find(x => x.tDone !== null && x.generated > 1);
  const s = E.requestSummary(sim, r);
  assert.deepEqual([s.id, s.prompt, s.state], [r.id, r.prompt, 'done']);
  near(s.ttftMs, r.tFirst - r.t0, 1e-9);
  near(s.totalMs, r.tDone - r.t0, 1e-9);
  near(s.tpotMs, (r.tDone - r.tFirst) / (r.generated - 1), 1e-9);
  assert.deepEqual(s.byKind, { queue: r.tAdmit - r.t0, prefill: r.tFirst - r.tAdmit, decode: r.tDone - r.tFirst });
  // a request still running: its open span runs to now
  const live = sim.instances[0].running.find(x => x.state === 'running');
  const ls = E.requestSummary(sim, live);
  assert.equal(ls.spans[ls.spans.length - 1].t1, sim.t);
  assert.equal(ls.totalMs, sim.t - live.t0);
});
test('follow: a rejected request ends at its 503', () => {
  const sim = E.createSim(Object.assign({}, E.PRESETS.batching, { seed: 1, config: { queueCap: 0 } }));
  const r = E.enqueue(sim, { prompt: 100, output: 10, model: 'llama-3-8b' });   // no queue room anywhere
  assert.equal(r.state, 'rejected');
  assert.deepEqual([r.marks.map(m => m.kind), r.spans.length], [['rejected'], 0]);
  assert.equal(E.requestSummary(sim, r).state, 'rejected');
});
test('config: continuous batching shows each server\'s vllm serve flags, with the slice and its memory share', () => {
  const sim = E.createSim(Object.assign({}, E.PRESETS.kvcache, { seed: 1, config: { gpuMemUtil: 0.7 } }));
  const [b] = E.serverConfig(sim);
  assert.equal(b.kind, 'vllm');
  assert.equal(b.title, 'MIG 3g.40gb · Llama 3 8B');
  const text = b.lines.map(l => l.text).join('\n');
  assert.match(text, /^vllm serve meta-llama\/Meta-Llama-3-8B-Instruct \\/);
  assert.match(text, /--gpu-memory-utilization 0\.70 \\/);
  assert.match(text, /--max-num-seqs 256 \\/);
  assert.match(text, /--max-num-batched-tokens 8192 \\/);
  assert.match(text, new RegExp('--max-model-len ' + sim.instances[0].maxModelLen + '$'));
  assert.equal(b.lines.find(l => /gpu-memory/.test(l.text)).key, 'gpu-memory-utilization');
  // switching back to continuous batching highlights the vllm serve line, as switching to request-level does Triton's
  assert.equal(b.lines.find(l => /^vllm serve/.test(l.text)).key, 'batching');
});
test('config: request-level batching is Triton\'s config.pbtxt with its dynamic_batching block', () => {
  const sim = E.createSim(Object.assign({}, E.PRESETS.batching, { seed: 1 }));
  E.setBatching(sim, 'request');
  const [b] = E.serverConfig(sim);
  assert.equal(b.kind, 'triton');
  const text = b.lines.map(l => l.text).join('\n');
  assert.match(text, /backend: "python"/);
  assert.match(text, /max_batch_size: 16/);
  assert.match(text, /max_queue_delay_microseconds: 25000/);
  assert.ok(b.lines.filter(l => l.key === 'batching').length >= 3);
});
test('config: tab 04 adds the gateway\'s routing block, and in API mode the API model has nothing to deploy', () => {
  const sim = E.createSim(Object.assign({}, E.PRESETS['routing-onprem'], { seed: 1 }));
  E.setThreshold(sim, 0.6);
  const blocks = E.serverConfig(sim);
  assert.deepEqual(blocks.map(b => b.kind), ['router', 'vllm', 'vllm', 'vllm']);
  assert.match(blocks[0].lines.find(l => l.key === 'threshold').text, /threshold: 0\.60/);
  assert.match(blocks[0].lines.find(l => l.key === 'large').text, /large: llama-3-8b/);
  assert.match(blocks[1].title, /System1/);
  // System1 is modelled, not a known checkpoint: the drawer says so rather than describing how it was built
  const s1 = blocks[1].lines.map(l => l.text).join('\n');
  assert.doesNotMatch(s1, /fine-tuned/);
  assert.match(s1, /sized like Llama 3\.2 1B here/);
  assert.match(s1, /no public checkpoint/);
  const api = E.serverConfig(E.createSim(Object.assign({}, E.PRESETS['routing-api'], { seed: 1 })));
  assert.deepEqual(api.map(b => b.kind), ['router', 'vllm', 'vllm', 'api']);
  assert.match(api[3].lines.map(l => l.text).join('\n'), /\$2 .*\$10/);
});
test('config: time-slicing shows each process\'s share of the one GPU, and tab 06 its load balancer and autoscaler', () => {
  const ts = E.serverConfig(E.createSim(Object.assign({}, E.PRESETS['mig-time'], { seed: 1 }))).filter(b => b.kind === 'vllm');
  assert.deepEqual(ts.map(b => b.lines.find(l => l.key === 'gpu-memory-utilization').text.trim()),
    ['--gpu-memory-utilization 0.45 \\', '--gpu-memory-utilization 0.25 \\', '--gpu-memory-utilization 0.20 \\']);
  assert.ok(ts.every(b => /time-sliced/.test(b.title)));
  const sim = failSim(1);
  let blocks = E.serverConfig(sim);
  assert.equal(blocks[0].kind, 'router');
  assert.match(blocks[0].lines.find(l => l.key === 'autoscaler').text, /autoscaler: off/);
  E.setAutoscaler(sim, true);
  blocks = E.serverConfig(sim);
  assert.match(blocks[0].lines.find(l => l.key === 'autoscaler').text, /autoscaler: on/);
  assert.deepEqual(blocks.slice(1).map(b => b.title), ['H100 1 · Llama 3 8B', 'H100 2 · Llama 3 8B']);
});

// ---- Sandbox ----

test('sandbox: round-robin splits requests evenly however busy a server is; least outstanding favours the faster one', () => {
  // an 8B on a 3g slice and one on a slower 2g slice, under load
  const base = { instances: [{ profile: '3g.40gb', model: 'llama-3-8b' }, { profile: '2g.20gb', model: 'llama-3-8b' }], batching: 'continuous', traffic: { rate: 6, bursts: false } };
  const routed = router => {
    const sim = E.createSim(Object.assign({}, base, { seed: 1 }, router ? { router } : {})), w = watchAll(sim);
    w.tick(30000);
    const n = [0, 0];
    for (const r of Object.values(w.all)) if (r.spans.length) n[r.spans[0].inst] += 1;
    return n;
  };
  const rr = routed('round-robin'), least = routed(null);
  // a few long prompts don't fit the 2g slice's max-model-len, so they skip to the 3g
  assert.ok(Math.abs(rr[0] - rr[1]) <= 3, `round-robin ${rr}`);
  assert.ok(least[0] > least[1] * 1.2, `least outstanding ${least}`);
});
test('sandbox: killing a GPU kills every server on it, and only while another GPU is up', () => {
  const sim = E.createSim(Object.assign({}, E.sandboxPreset(Object.assign({}, E.SANDBOX_DEFAULTS, { gpus: 2 })), { seed: 1 }));
  assert.equal(sim.instances.length, 6);
  assert.equal(E.killGpu(sim), 1);
  assert.deepEqual(sim.instances.map(i => E.instanceStatus(sim, i).state), ['up', 'up', 'up', 'down', 'down', 'down']);
  assert.equal(E.killGpu(sim), null);   // the last GPU's three servers stay up
  const one = E.createSim(Object.assign({}, E.PRESETS['mig-mig'], { seed: 1 }));
  assert.equal(E.killGpu(one), null);   // three slices of one H100 are one GPU
});
test('sandbox: the cost meter adds up the GPUs billed over time, and output tokens', () => {
  const sim = E.createSim(Object.assign({}, E.PRESETS.failure, { seed: 1 }));
  runExact(sim, 10000);
  near(sim.stats.gpuMs, 2 * 10000, 1e-6);
  E.killGpu(sim);
  runExact(sim, 10000);
  near(sim.stats.gpuMs, 2 * 10000 + 10000, 1e-6);
  near(E.spentUsd(sim), E.GPU_HOUR_USD * 30000 / 3.6e6, 1e-12);
  const made = sim.finished.reduce((n, r) => n + r.generated, 0);
  assert.ok(sim.stats.outputTokens >= made && sim.stats.outputTokens > 0);
});
test('sandbox: settings build a deployment: layouts, models per slice, GPUs, and traffic per model', () => {
  const p = E.sandboxPreset(E.SANDBOX_DEFAULTS);
  assert.deepEqual(p.instances.map(i => [i.profile, i.model, i.gpu]), [['3g.40gb', 'llama-3-8b', 0], ['2g.20gb', 'llama-3.2-3b', 0], ['2g.20gb', 'llama-3.2-1b', 0]]);
  assert.deepEqual(p.streams.map(s => s.model), ['llama-3-8b', 'llama-3.2-3b', 'llama-3.2-1b']);
  near(p.streams.reduce((n, s) => n + s.rate, 0), E.SANDBOX_DEFAULTS.rate, 1e-9);   // the rate is the total, split across the models
  assert.deepEqual(Object.keys(p.slo).sort(), ['llama-3-8b', 'llama-3.2-1b', 'llama-3.2-3b']);
  const two = E.sandboxPreset(Object.assign({}, E.SANDBOX_DEFAULTS, { gpus: 2, layout: 'whole', models: ['llama-3-8b'], router: 'round-robin', batching: 'request', gpuMemUtil: 0.7, maxNumSeqs: 64 }));
  assert.deepEqual(two.instances.map(i => [i.profile, i.gpu]), [['7g.80gb', 0], ['7g.80gb', 1]]);
  assert.deepEqual([two.router, two.batching, two.config.gpuMemUtil, two.config.maxNumSeqs, two.streams.length], ['round-robin', 'request', 0.7, 64, 1]);
  const ts = E.sandboxPreset(Object.assign({}, E.SANDBOX_DEFAULTS, { layout: 'time-sliced' }));
  assert.ok(ts.instances.every(i => i.profile === '7g.80gb' && i.gpu === 0 && i.gpuMemUtil > 0));
  const small = E.sandboxPreset(Object.assign({}, E.SANDBOX_DEFAULTS, { layout: '2g+2g+2g+1g', models: ['llama-3.2-1b'] }));
  assert.deepEqual(small.instances.map(i => i.profile), ['2g.20gb', '2g.20gb', '2g.20gb', '1g.10gb']);
  assert.ok(small.instances.every(i => i.model === 'llama-3.2-1b'));   // a short models list repeats its last
  assert.throws(() => E.sandboxPreset(Object.assign({}, E.SANDBOX_DEFAULTS, { layout: '9g' })), /layout/);
  assert.equal(E.sandboxPreset(Object.assign({}, E.SANDBOX_DEFAULTS, { traffic: 'trace' }), D).streams[0].trace, D);
});
test('sandbox: every layout and model choice deploys and runs', () => {
  for (const layout of Object.keys(E.SANDBOX_LAYOUTS)) for (const m of ['llama-3-8b', 'llama-3.2-3b', 'llama-3.2-1b']) for (const gpus of [1, 3]) {
    const sim = E.createSim(Object.assign({}, E.sandboxPreset(Object.assign({}, E.SANDBOX_DEFAULTS, { layout, models: [m], gpus })), { seed: 1 }));
    runExact(sim, 3000);
    assert.ok(sim.stats.arrived > 0, `${layout} ${m} ×${gpus}`);
  }
});
// The SLO challenge as the page runs it: no warm-up, a refresh every 300 ms, failing on a 30 s p99 over the
// target or on any 503; done once the window's requests are all served
function runChallenge(settings) {
  const sim = E.createSim(Object.assign({}, E.challengePreset(settings, D), { seed: 1 }));
  let next = PAGE.sampleMs, failedAt = null;
  while (!E.isDrained(sim) && sim.t < 400000) {
    E.tick(sim, PAGE.tickMs);
    if (sim.t >= next) {
      next += PAGE.sampleMs;
      const p99 = E.metrics(sim, 'llama-3-8b', E.CHALLENGE.windowMs).ttftP99;
      if (failedAt === null && ((p99 !== null && p99 > E.CHALLENGE.sloMs) || sim.stats.rejected > 0)) failedAt = sim.t;
    }
  }
  return { failedAt, cost: E.spentUsd(sim) / sim.stats.outputTokens * 1e6, ms: sim.t, arrived: sim.stats.arrived };
}
test('challenge: the window replays minutes 20-35 of the hour once, at 12×, to the 8B', () => {
  const sim = E.createSim(Object.assign({}, E.challengePreset(E.SANDBOX_DEFAULTS, D), { seed: 1 }));
  assert.deepEqual(sim.streams.map(s => s.model), ['llama-3-8b']);
  const due = TRACE_T.filter(t => t >= E.CHALLENGE.startMs && t < E.CHALLENGE.endMs).length;
  runExact(sim, (E.CHALLENGE.endMs - E.CHALLENGE.startMs) / D.speed + 30000);
  assert.equal(sim.stats.arrived, due);
  assert.throws(() => E.challengePreset(Object.assign({}, E.SANDBOX_DEFAULTS, { models: ['llama-3.2-1b'] }), D), /8B/);
});
test('challenge: one H100 fails at the peak; two pass, and their cost per 1M is the par', () => {
  const one = runChallenge(Object.assign({}, E.SANDBOX_DEFAULTS, { gpus: 1, layout: 'whole', models: ['llama-3-8b'] }));
  assert.notEqual(one.failedAt, null);
  const two = runChallenge(Object.assign({}, E.SANDBOX_DEFAULTS, E.CHALLENGE.par));
  assert.equal(two.failedAt, null);
  near(two.cost, E.CHALLENGE.parUsdPer1M, E.CHALLENGE.parUsdPer1M * 0.02);
});
test('sandbox: the router policy can change live, marked on the sparkline', () => {
  const sim = E.createSim(Object.assign({}, E.sandboxPreset(E.SANDBOX_DEFAULTS), { seed: 1 }));
  E.setRouter(sim, 'round-robin');
  assert.equal(sim.router, 'round-robin');
  assert.equal(sim.events[sim.events.length - 1].label, 'round-robin');
  E.setRouter(sim, 'least');
  assert.equal(sim.events[sim.events.length - 1].label, 'least outstanding');
  assert.throws(() => E.setRouter(sim, 'random'), /router/);
});
test('terminal: commands change the settings, or say what\'s wrong', () => {
  const S = E.SANDBOX_DEFAULTS, run = (line, s = S) => E.sandboxCommand(s, line);
  let r = run('gpus 2');
  assert.deepEqual([r.ok, r.action, r.settings.gpus], [true, 'deploy', 2]);
  assert.equal(S.gpus, 1);   // the defaults are left alone
  r = run('layout whole');
  assert.deepEqual([r.ok, r.action, r.settings.layout], [true, 'deploy', 'whole']);
  r = run('models 8b 8b');
  assert.deepEqual(r.settings.models, ['llama-3-8b', 'llama-3-8b']);
  r = run('set gpu-mem 0.75');
  assert.deepEqual([r.ok, r.settings.gpuMemUtil], [true, 0.75]);
  assert.equal(run('set gpu-mem 1.2').ok, false);
  r = run('set max-num-seqs 64');
  assert.equal(r.settings.maxNumSeqs, 64);
  assert.deepEqual([run('rate 18').settings.rate, run('bursts off').settings.bursts, run('lengths long').settings.lengths], [18, false, 'long']);
  assert.deepEqual([run('traffic trace').settings.traffic, run('traffic trace').action], ['trace', 'deploy']);
  // live ones don't redeploy
  assert.deepEqual([run('batching request').action, run('batching request').settings.batching], ['batching', 'request']);
  assert.deepEqual([run('router round-robin').action, run('router round-robin').settings.router], ['router', 'round-robin']);
  assert.deepEqual([run('autoscaler on').action, run('autoscaler on').settings.autoscaler], ['autoscaler', true]);
  for (const a of ['kill', 'pause', 'play', 'challenge', 'status', 'reset', 'clear', 'help']) assert.equal(run(a).action, a, a);
  assert.deepEqual([run('burst').action, run('burst').value, run('burst 40').value], ['burst', 24, 40]);
  // more servers than the canvas can show, an unknown command, a bad value
  r = run('gpus 3', Object.assign({}, S, { layout: '3g+2g+2g' }));
  assert.equal(r.ok, false);
  assert.match(r.message, /6 servers/);
  assert.equal(run('layout 2g+2g+2g+1g', Object.assign({}, S, { gpus: 2 })).ok, false);
  assert.match(run('frobnicate').message, /help/);
  assert.equal(run('models 7b').ok, false);
  assert.equal(run('').action, null);
  assert.match(run('help').message, /gpus/);
});
test('config: with several servers the router block names its policy and the queue limit behind the 503s', () => {
  const sim = E.createSim(Object.assign({}, E.sandboxPreset(E.SANDBOX_DEFAULTS), { seed: 1 }));
  let r = E.serverConfig(sim)[0];
  assert.equal(r.kind, 'router');
  assert.match(r.lines.find(l => l.key === 'router').text, /policy: least outstanding requests/);
  assert.match(r.lines.map(l => l.text).join('\n'), /max queued per server: 128 +# then 503/);
  E.setRouter(sim, 'round-robin');
  r = E.serverConfig(sim)[0];
  assert.match(r.lines.find(l => l.key === 'router').text, /policy: round-robin/);
  assert.equal(E.serverConfig(E.createSim(Object.assign({}, E.PRESETS.batching, { seed: 1 })))[0].kind, 'vllm');   // one server: no router block
});
test('challenge: done only once the whole window is served: a pause, a drain or play afterwards doesn\'t end it early or keep it going', () => {
  const sim = E.createSim(Object.assign({}, E.challengePreset(Object.assign({}, E.SANDBOX_DEFAULTS, E.CHALLENGE.par), D), { seed: 1 }));
  runExact(sim, 5000);
  E.setArrivals(sim, false);
  runExact(sim, 30000);
  assert.ok(E.isDrained(sim));
  assert.equal(E.challengeDone(sim), false);   // paused and drained, but most of the window is still to come
  E.setArrivals(sim, true);
  while (!E.challengeDone(sim) && sim.t < 300000) E.tick(sim, 50);
  assert.ok(E.challengeDone(sim));
  E.setArrivals(sim, true);                     // play after the end: nothing is left to arrive, so it stays done
  assert.equal(sim.arrivalsOn, false);
  assert.ok(E.challengeDone(sim));
  assert.equal(E.challengeDone(E.createSim(Object.assign({}, E.PRESETS.batching, { seed: 1 }))), false);
});
test('sandbox: with the autoscaler on, a killed MIG H100 comes back as one H100, slices and all', () => {
  const sim = E.createSim(Object.assign({}, E.sandboxPreset(Object.assign({}, E.SANDBOX_DEFAULTS, { gpus: 2, autoscaler: true })), { seed: 1 }));
  runExact(sim, 2000);
  assert.equal(E.killGpu(sim), 1);
  assert.equal(sim.gpuCount, 2);   // the replacement is billed from now on: one GPU, not three
  assert.deepEqual(sim.events.filter(e => / starting$/.test(e.label)).map(e => e.label), ['H100 3 starting']);
  assert.deepEqual(sim.instances.slice(3).map(i => [E.instanceStatus(sim, i).state, i.gpu]), [['starting', 2], ['starting', 2], ['starting', 2]]);
  runExact(sim, E.COLD_START_MS + 100);
  assert.equal(sim.gpuCount, 2);
  assert.deepEqual(sim.events.filter(e => / up$/.test(e.label)).map(e => e.label), ['H100 3 up']);
  assert.equal(E.killGpu(sim), 2);   // the next kill takes the whole replacement
  assert.deepEqual(sim.instances.slice(3).map(i => E.instanceStatus(sim, i).state), ['starting', 'starting', 'starting']);
  assert.equal(sim.gpuCount, 2);
});
test('sandbox: time-sliced processes share the memory the gpu-mem knob gives, in tab 03\'s proportions', () => {
  const at = u => E.sandboxPreset(Object.assign({}, E.SANDBOX_DEFAULTS, { layout: 'time-sliced', gpuMemUtil: u })).instances.map(i => +i.gpuMemUtil.toFixed(4));
  assert.deepEqual(at(0.9), [0.45, 0.25, 0.2]);
  assert.deepEqual(at(0.5), [0.25, +(0.5 * 0.25 / 0.9).toFixed(4), +(0.5 * 0.2 / 0.9).toFixed(4)]);
});
test('config: a model that doesn\'t fit its slice says so instead of printing a command that won\'t start', () => {
  const sim = E.createSim(Object.assign({}, E.sandboxPreset(Object.assign({}, E.SANDBOX_DEFAULTS, { layout: '2g+2g+2g+1g', models: ['llama-3.2-1b', 'llama-3.2-1b', 'llama-3.2-1b', 'llama-3-8b'] })), { seed: 1 }));
  const b = E.serverConfig(sim).find(x => /1g\.10gb/.test(x.title));
  assert.equal(b.kind, 'unfit');
  assert.match(b.title, /doesn't fit/);
  assert.match(b.lines.map(l => l.text).join('\n'), /won't start: 16\.06 GB of weights/);
  assert.ok(!b.lines.some(l => /vllm serve/.test(l.text)));
});
