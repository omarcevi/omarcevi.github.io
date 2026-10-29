import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../assets/photo-noise.js');

function rel(a, b, tol) {
  assert.ok(Math.abs(a - b) <= tol * Math.abs(b), a + ' is not within ' + tol + ' (relative) of ' + b);
}

// Pinned from diffusers 0.42.1 (torch 2.15.0), checked 2026-10-29:
// DDIMScheduler(num_train_timesteps=1000, beta_schedule='squaredcos_cap_v2').alphas_cumprod
test('cosine alphas_cumprod match diffusers squaredcos_cap_v2', () => {
  const a = P.cosineAlphasCumprod(1000);
  assert.equal(a.length, 1000);
  const want = { 0: 0.9999586939811707, 1: 0.9999125599861145, 250: 0.8458880186080933, 500: 0.4922850430011749,
    750: 0.14317865669727325, 980: 0.0008765292004682124, 998: 2.428766265438753e-06, 999: 2.4287349909002387e-09 };
  for (const t in want) rel(a[t], want[t], 1e-4);
});

// DDIMScheduler(...).set_timesteps(50).timesteps, "leading" spacing, steps_offset 0
test('50 DDIM timesteps match diffusers: 980, 960, ..., 0', () => {
  const ts = P.ddimTimesteps(50, 1000);
  assert.equal(ts.length, 50);
  assert.deepEqual(ts.slice(0, 3), [980, 960, 940]);
  assert.deepEqual(ts.slice(-3), [40, 20, 0]);
  for (let i = 1; i < ts.length; i++) assert.equal(ts[i - 1] - ts[i], 20);
});

test('gaussian noise is fixed by its seed', () => {
  assert.deepEqual(P.gaussian(42, 1000), P.gaussian(42, 1000));
  assert.notDeepEqual(P.gaussian(42, 1000), P.gaussian(7, 1000));
});

test('gaussian noise is standard normal', () => {
  const e = P.gaussian(42, 200001);
  assert.equal(e.length, 200001);
  let s = 0, s2 = 0;
  for (const v of e) { s += v; s2 += v * v; }
  const mean = s / e.length, sd = Math.sqrt(s2 / e.length - mean * mean);
  assert.ok(Math.abs(mean) < 0.01, 'mean ' + mean);
  assert.ok(Math.abs(sd - 1) < 0.01, 'sd ' + sd);
});

// One RGBA pixel and its three noise values
const SRC = new Uint8ClampedArray([200, 100, 0, 255]);
const EPS = new Float32Array([0.5, -0.5, 4]);

test('noiseImage at sqrt(abar)=1 is the photo', () => {
  const dst = new Uint8ClampedArray(4);
  P.noiseImage(SRC, EPS, 1, 0, dst);
  assert.deepEqual([...dst], [200, 100, 0, 255]);
});

test('noiseImage mixes in [-1, 1] pixel space: x_t = a*x0 + b*eps', () => {
  const dst = new Uint8ClampedArray(4);
  P.noiseImage(SRC, EPS, 0, 1, dst);                        // pure noise: (eps + 1) * 127.5, clamped
  assert.deepEqual([...dst], [191, 64, 255, 255]);
  P.noiseImage(SRC, EPS, 0.6, 0.8, dst);
  // red: x0 = 200/127.5 - 1 = 0.5686; 0.6*0.5686 + 0.8*0.5 = 0.7412 -> 222.0
  assert.deepEqual([...dst.slice(0, 2)], [222, 60]);
});

test('stamp raises t around the point, peak at the centre, nothing past the radius', () => {
  const W = 50, H = 40, tmap = new Float32Array(W * H);
  const box = P.stamp(tmap, W, H, 20, 20, 10, 800);
  assert.equal(tmap[20 * W + 20], 800);
  assert.ok(tmap[20 * W + 25] > 0 && tmap[20 * W + 25] < 800);
  assert.equal(tmap[20 * W + 31], 0);
  assert.deepEqual(box, [10, 10, 30, 30]);
});

test('stamp never lowers a pixel that is already noisier', () => {
  const W = 50, H = 40, tmap = new Float32Array(W * H);
  tmap[20 * W + 25] = 900;
  P.stamp(tmap, W, H, 20, 20, 10, 800);
  assert.equal(tmap[20 * W + 25], 900);
});

test('stamp is clipped to the image', () => {
  const W = 50, H = 40, tmap = new Float32Array(W * H);
  assert.deepEqual(P.stamp(tmap, W, H, 2, 38, 10, 800), [0, 28, 12, 39]);
  assert.equal(P.stamp(tmap, W, H, -30, -30, 10, 800), null);
});

test('heal lowers t to zero and returns the highest t left', () => {
  const W = 50, H = 40, tmap = new Float32Array(W * H);
  const box = P.stamp(tmap, W, H, 20, 20, 10, 800);
  assert.equal(P.heal(tmap, W, box, 500), 300);
  assert.equal(tmap[20 * W + 20], 300);
  assert.equal(P.heal(tmap, W, box, 500), 0);
  assert.equal(tmap[20 * W + 20], 0);
});

test('noiseRect uses each pixel\'s own t and leaves the rest of the image alone', () => {
  const W = 3, H = 1;
  const src = new Uint8ClampedArray([200, 100, 0, 255, 200, 100, 0, 255, 200, 100, 0, 255]);
  const eps = new Float32Array([0.5, -0.5, 4, 0.5, -0.5, 4, 0.5, -0.5, 4]);
  const tmap = new Float32Array([0, 1.7, 2]);
  const SA = new Float32Array([1, 0.6, 0]), SB = new Float32Array([0, 0.8, 1]);
  const dst = new Uint8ClampedArray(12).fill(9);
  P.noiseRect(src, eps, tmap, SA, SB, W, [0, 0, 1, 0], dst);
  assert.deepEqual([...dst.slice(0, 4)], [200, 100, 0, 255]);   // t = 0: the photo
  assert.deepEqual([...dst.slice(4, 6)], [222, 60]);            // t = 1.7 rounds down to 1
  assert.deepEqual([...dst.slice(8)], [9, 9, 9, 9]);            // outside the rect
});
