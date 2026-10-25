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
  while (b.preemptions === 0) E.tick(sim, 16);
  assert.equal(inst.queue[0], b);                                // newest out, back to the front
  assert.equal(b.generated, 585);                                // 2 * 3001 + 2 * 585 > 7171 tokens of KV
  assert.equal(b.prefillTarget, 3000 + 585);
  assert.equal(a.state, 'running');
  const tFirst = b.tFirst;
  run(sim, 60000);
  assert.equal(b.state, 'done');
  assert.equal(b.generated, 1000);
  assert.equal(b.tFirst, tFirst);
});
