// Hero photo: the forward diffusion process, x_t = sqrt(abar_t) x0 + sqrt(1 - abar_t) eps, on the real
// photo. On load it steps through the 50 timesteps a 50-step DDIM sampler visits (noise to photo); after
// that, the pointer is a brush that raises t where it passes, and t falls back to 0.
// Nothing here is a model: the load-in is the noising played backward, and the brush gives each pixel its
// own t, where a model sees one t per image. abar_t is diffusers' cosine schedule (squaredcos_cap_v2);
// tests/photo-noise.test.mjs pins it, and the DDIM timesteps, against diffusers.
// The math has no DOM access: it runs in Node for tests and as window.PhotoNoise in the page.
(function (root) {
  'use strict';

  // diffusers' betas_for_alpha_bar("cosine"): beta_i = min(1 - f((i+1)/T) / f(i/T), 0.999), abar = cumprod(1 - beta)
  function cosineAlphasCumprod(T) {
    function f(x) { return Math.pow(Math.cos((x + 0.008) / 1.008 * Math.PI / 2), 2); }
    var a = new Float64Array(T), p = 1;
    for (var i = 0; i < T; i++) { p *= 1 - Math.min(1 - f((i + 1) / T) / f(i / T), 0.999); a[i] = p; }
    return a;
  }

  // DDIMScheduler.set_timesteps with "leading" spacing and steps_offset 0
  function ddimTimesteps(steps, T) {
    var ratio = Math.floor(T / steps), ts = [];
    for (var i = steps - 1; i >= 0; i--) ts.push(i * ratio);
    return ts;
  }

  // Standard normal samples: mulberry32 for uniforms, Box-Muller for the normals
  function gaussian(seed, n) {
    var s = seed | 0, out = new Float32Array(n);
    function rand() {
      s = s + 0x6D2B79F5 | 0;
      var t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    for (var i = 0; i < n; i += 2) {
      var r = Math.sqrt(-2 * Math.log(1 - rand())), th = 2 * Math.PI * rand();
      out[i] = r * Math.cos(th);
      if (i + 1 < n) out[i + 1] = r * Math.sin(th);
    }
    return out;
  }

  // One t for the whole RGBA image, a = sqrt(abar_t) and b = sqrt(1 - abar_t). Pixels are mixed in
  // [-1, 1], as diffusers does: (a (p/127.5 - 1) + b eps + 1) * 127.5 = a p + 127.5 (1 - a + b eps)
  function noiseImage(src, eps, a, b, dst) {
    var c = 127.5 * (1 - a), k = 127.5 * b;
    for (var j = 0, i = 0; j < src.length; j += 4, i += 3) {
      dst[j] = a * src[j] + c + k * eps[i];
      dst[j + 1] = a * src[j + 1] + c + k * eps[i + 1];
      dst[j + 2] = a * src[j + 2] + c + k * eps[i + 2];
      dst[j + 3] = 255;
    }
  }

  // The brush's falloff, a Gaussian cut off at the radius, kept per radius
  var kernels = {};
  function kernel(r) {
    if (kernels[r]) return kernels[r];
    var n = 2 * r + 1, k = new Float32Array(n * n), sig2 = 2 * Math.pow(r / 2.2, 2);
    for (var y = -r; y <= r; y++) for (var x = -r; x <= r; x++) {
      var d2 = x * x + y * y;
      k[(y + r) * n + x + r] = d2 > r * r ? 0 : Math.exp(-d2 / sig2);
    }
    return (kernels[r] = k);
  }

  // Raises t around (cx, cy) to at most peak, never lowering a pixel; returns the box it touched
  // ([x0, y0, x1, y1], inclusive), or null when the brush is off the image
  function stamp(tmap, W, H, cx, cy, r, peak) {
    cx = Math.round(cx); cy = Math.round(cy);
    var x0 = Math.max(0, cx - r), x1 = Math.min(W - 1, cx + r);
    var y0 = Math.max(0, cy - r), y1 = Math.min(H - 1, cy + r);
    if (x0 > x1 || y0 > y1) return null;
    var k = kernel(r), n = 2 * r + 1;
    for (var y = y0; y <= y1; y++) {
      var row = (y - cy + r) * n - cx + r;
      for (var x = x0; x <= x1; x++) {
        var v = peak * k[row + x], p = y * W + x;
        if (v > tmap[p]) tmap[p] = v;
      }
    }
    return [x0, y0, x1, y1];
  }

  // Lowers every t in the box by amount, down to 0; returns the highest t left
  function heal(tmap, W, box, amount) {
    var max = 0;
    for (var y = box[1]; y <= box[3]; y++) for (var p = y * W + box[0], e = y * W + box[2]; p <= e; p++) {
      var t = tmap[p];
      if (t === 0) continue;
      t = t > amount ? t - amount : 0;
      tmap[p] = t;
      if (t > max) max = t;
    }
    return max;
  }

  // Each pixel in the box at its own t (rounded down); t = 0 is the photo itself
  function noiseRect(src, eps, tmap, SA, SB, W, box, dst) {
    for (var y = box[1]; y <= box[3]; y++) for (var p = y * W + box[0], e = y * W + box[2]; p <= e; p++) {
      var j = p * 4, t = tmap[p] | 0;
      if (t === 0) { dst[j] = src[j]; dst[j + 1] = src[j + 1]; dst[j + 2] = src[j + 2]; dst[j + 3] = src[j + 3]; continue; }
      var a = SA[t], c = 127.5 * (1 - a), k = 127.5 * SB[t], i = p * 3;
      dst[j] = a * src[j] + c + k * eps[i];
      dst[j + 1] = a * src[j + 1] + c + k * eps[i + 1];
      dst[j + 2] = a * src[j + 2] + c + k * eps[i + 2];
      dst[j + 3] = 255;
    }
  }

  var T = 1000, STEPS = 50, SEED = 42;
  var HOLD_MS = 200, STEP_MS = 24;              // pure noise first, then 50 steps: about 1.4 s in all
  var BRUSH_R = 110, BRUSH_PEAK = 800, HEAL_PER_MS = 0.85; // in image pixels; a patch heals in about a second

  function initPhotoNoise(doc) {
    var cv = doc.getElementById('pn'), img = cv && cv.parentNode.querySelector('img');
    var status = doc.getElementById('pn-status'), replay = doc.getElementById('pn-replay');
    var ctx = cv && cv.getContext && cv.getContext('2d');
    if (!img || !ctx) return;
    var win = doc.defaultView, W = cv.width, H = cv.height, N = W * H;
    var reduce = win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var hint = win.matchMedia && win.matchMedia('(hover: hover)').matches ? 'hover to add noise' : 'drag to add noise';
    // index.html's CSS takes the canvas away after 4 s unless it has .on: if that happened, the photo is up already
    var late = win.getComputedStyle(cv).visibility === 'hidden';

    var abar = cosineAlphasCumprod(T), SA = new Float32Array(T), SB = new Float32Array(T);
    for (var t = 0; t < T; t++) { SA[t] = Math.sqrt(abar[t]); SB[t] = Math.sqrt(1 - abar[t]); }
    var steps = ddimTimesteps(STEPS, T), eps = gaussian(SEED, N * 3), tmap = new Float32Array(N);
    var out = ctx.createImageData(W, H), src = null, raf = 0, state = 'intro';

    function pad(v, n) { v = String(v); while (v.length < n) v = ' ' + v; return v; } // figure spaces keep the line still
    function say(s) { if (status) status.textContent = s; }
    function at(t) { return 't=' + pad(t, 3) + ' · ᾱ_t=' + abar[t].toFixed(3); }
    function ready() { state = 'ready'; replay.disabled = false; say('x₀ · t=0 · ' + hint); }
    function fail() { // the plain photo and caption, as without JS
      cancelAnimationFrame(raf); cv.style.display = 'none'; img.style.visibility = 'visible';
      var info = doc.querySelector('.pn-info'); if (info) info.style.display = 'none';
    }

    // t = 999 before the photo is here: sqrt(abar_999) is 5e-5, so the photo would not move a pixel
    function noiseFrame() {
      noiseImage(out.data, eps, 0, 1, out.data);
      ctx.putImageData(out, 0, 0);
      say('cosine · step ' + pad(0, 2) + '/' + STEPS + ' · ' + at(T - 1));
    }

    function intro() {
      state = 'intro'; replay.disabled = true;
      tmap.fill(0); box = null;
      var k = -1, due = -1;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function tick(now) {
        if (!src || due < 0) due = now + HOLD_MS;   // pure noise until the photo is here, then HOLD_MS more
        else if (now >= due) {                       // STEP_MS apart on average, but one step per frame at most,
          k++; due = Math.max(due + STEP_MS, now);   // so a hidden tab picks up where it left off
          if (k === STEPS) { ctx.putImageData(src, 0, 0); ready(); return; }
          var ts = steps[k];
          noiseImage(src.data, eps, SA[ts], SB[ts], out.data);
          ctx.putImageData(out, 0, 0);
          say('cosine · step ' + pad(k + 1, 2) + '/' + STEPS + ' · ' + at(ts));
        }
        raf = requestAnimationFrame(tick);
      });
    }

    // The brush: box is everything stamped since the last patch healed
    var box = null, lastPt = null, prev = 0;
    function grow(b) {
      if (!b) return;
      box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
    }
    function brushTick(now) {
      var max = heal(tmap, W, box, Math.min(now - prev, 50) * HEAL_PER_MS);
      prev = now;
      noiseRect(src.data, eps, tmap, SA, SB, W, box, out.data);
      ctx.putImageData(out, 0, 0, box[0], box[1], box[2] - box[0] + 1, box[3] - box[1] + 1);
      if (max === 0) { box = null; raf = 0; ready(); return; }
      say('cosine · brush · max ' + at(max | 0));
      raf = requestAnimationFrame(brushTick);
    }
    function brush(e) {
      if (state !== 'ready' && state !== 'brush') return;
      var r = cv.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W, y = (e.clientY - r.top) / r.height * H;
      // a stroke joins its points; after a pause (or a scroll, which moves the photo under a still cursor) it starts over
      var from = lastPt && lastPt.id === e.pointerId && e.timeStamp - lastPt.t < 100 ? lastPt : { x: x, y: y };
      var d = Math.hypot(x - from.x, y - from.y), n = Math.max(1, Math.ceil(d / (BRUSH_R / 2))); // fill fast strokes
      for (var i = 1; i <= n; i++) grow(stamp(tmap, W, H, from.x + (x - from.x) * i / n, from.y + (y - from.y) * i / n, BRUSH_R, BRUSH_PEAK));
      lastPt = { id: e.pointerId, x: x, y: y, t: e.timeStamp };
      if (box && state !== 'brush') { state = 'brush'; prev = performance.now(); raf = requestAnimationFrame(brushTick); }
    }
    function lift() { lastPt = null; }
    cv.addEventListener('pointerdown', brush);
    cv.addEventListener('pointermove', brush);
    cv.addEventListener('pointerup', lift);
    cv.addEventListener('pointerleave', lift);
    cv.addEventListener('pointercancel', lift); // a vertical swipe became a scroll
    win.addEventListener('scroll', lift, { passive: true });

    replay.addEventListener('click', function () { cancelAnimationFrame(raf); noiseFrame(); intro(); });

    function take() {
      try {                                        // off screen: the photo must not flash on the canvas
        var off = doc.createElement('canvas'), octx = off.getContext('2d');
        off.width = W; off.height = H;
        octx.drawImage(img, 0, 0, W, H);
        src = octx.getImageData(0, 0, W, H);
      } catch (e) { fail(); return; }
      img.style.visibility = 'visible';           // under the canvas, for anything that reads the photo
      if (reduce || late) { ctx.putImageData(src, 0, 0); cv.classList.add('on'); ready(); }
    }

    if (!late) cv.classList.add('on');
    if (!reduce && !late) { noiseFrame(); intro(); } // intro waits for src
    if (img.complete && img.naturalWidth) take();
    else { img.addEventListener('load', take); img.addEventListener('error', fail); }

    // The "?" opens a popover, placed under it in page coordinates (as the simulator's are)
    var pop = doc.getElementById('pn-about'), more = doc.querySelector('[popovertarget="pn-about"].pn-more');
    if (pop && more) pop.addEventListener('toggle', function (e) {
      var open = e.newState === 'open';
      more.classList.toggle('open', open);
      if (!open) return;
      var r = more.getBoundingClientRect(), w = pop.offsetWidth;
      pop.style.top = (r.bottom + win.scrollY + 8) + 'px';
      pop.style.left = (win.scrollX + Math.max(16, Math.min(r.right - w + 24, doc.documentElement.clientWidth - w - 16))) + 'px';
    });
  }

  var api = { cosineAlphasCumprod: cosineAlphasCumprod, ddimTimesteps: ddimTimesteps, gaussian: gaussian, noiseImage: noiseImage,
    stamp: stamp, heal: heal, noiseRect: noiseRect, initPhotoNoise: initPhotoNoise };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PhotoNoise = api;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { initPhotoNoise(document); });
    else initPhotoNoise(document);
  }
})(this);
