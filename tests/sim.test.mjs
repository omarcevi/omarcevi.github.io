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
