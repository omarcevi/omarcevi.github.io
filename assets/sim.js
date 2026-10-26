// Inference simulator, page side: draws the engine in assets/sim-engine.js (window.SimEngine)
// on the #sim canvas and wires the panel's controls. Each tab is an engine preset, rebuilt and
// warmed up when the tab opens; tab 02's memory slider, tab 03's deployment switch and tab 04's
// large-model switch redeploy the same way, while tab 04's routing threshold moves live. The canvas
// shows arrivals, each instance's queue lane, its running sequences (one row each, flashing amber when
// preempted) and KV cache, the token stream, and a rolling TTFT p99 line with a marker for each switch
// the visitor makes. In tabs 03 and 04 each box also shows its model's p99 next to that model's SLO
// (green or red, and in words in the canvas's aria-label), and in tab 03 a time-sliced step's stretch.
// Tab 04 has its own layout, left to right: a request queues and is scored at the System1 box in the middle,
// then its dot goes down one of two branches, labelled with the routing rule, to the small or the large model's
// lane. In API mode the large model is a dashed box with no lane or KV that names the API model's spend.
// Animations run on the page's frame clock; the sim's own clock stops once it has drained.
(function () {
  'use strict';
  var E = window.SimEngine;
  var box = document.getElementById('simbox'), cv = document.getElementById('sim');
  if (!E || !box || !cv || !cv.getContext) return;
  var ctx = cv.getContext('2d');
  var REDUCE = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function $(id) { return document.getElementById(id); }

  var WARMUP_TICKS = 500, TICK_MS = 16;  // 8 s of sim time, so a tab never opens empty
  var TAB03_WARMUP_TICKS = 2500;         // 40 s in tabs 03 and 04, so a deployment opens on steady state with a full 30 s p99 window
  var SAMPLE_MS = 300, SAMPLES = 110;    // footer refresh and sparkline samples, in sim time
  var FLASH_MS = 300;                    // a finished row flashes green this long, a preempted one amber
  var P99_WINDOW_MS = 30000;             // a box's p99 vs its SLO: its model's first tokens of the last 30 s (at most the latest 200), the footer's window
  var TALL_AT = 3;                       // instances: from three, the canvas grows (#sim.tall) so each box draws 6 rows (5 on phones)
  var BURST = 24;
  var ROW_H = 4, ROW_GAP = 2.2, CELL = 9.5, DOT_R = 3.2, STRIP_H = 26;
  var FADE_NEAR = 18, FADE_SPAN = 40;    // a dot for a row under "+N more" is gone this close to its target (px)
  var HOP_MS = 450;                      // tab 04: a scored request's dot goes down its branch in this long
  var TOKENS_PER_PARTICLE = 100, MAX_PARTICLES_PER_S = 30;
  var FONT = '"Geist Mono", ui-monospace, monospace';
  var COL = {
    faint: '#5c626d', muted: '#8b919c', accent: '#7aa2ff', ok: '#4ade80', warn: '#f5a524', bad: '#ef4444',
    panel: '#0f1115', box: '#161920', line: '#2a2f38', track: '#232830', sep: '#1c2027',
    prefillTodo: 'rgba(122,162,255,0.22)', decode: 'rgba(122,162,255,0.6)', idle: 'rgba(139,145,156,0.35)',
    doneDecode: 'rgba(74,222,128,0.55)', preDecode: 'rgba(245,165,36,0.55)', free: 'rgba(122,162,255,0.55)',
    lane: 'rgba(220,225,235,0.12)', grid: 'rgba(220,225,235,0.06)', branch: 'rgba(122,162,255,0.45)'
  };
  var BASE = [208, 213, 222], WARN = [245, 165, 36], BAD = [239, 68, 68];
  var PLAY = {
    running: ['❚❚', 'Pause: stop new requests and let in-flight ones finish'],
    draining: ['draining…', 'Draining in-flight requests. Play: start new requests again'],
    stopped: ['▶ play', 'Play: start new requests']
  };
  // What each preset is called: the header note, the canvas's top label (narrow: 560px and under)
  // and the canvas's aria-label
  var VIEWS = {
    batching: {
      note: '· Llama 3 8B on one H100 · real time', label: 'H100 · Llama 3 8B', narrow: 'H100',
      aria: 'Animated simulation: requests are routed to an LLM server on one H100 and batched step by step'
    },
    kvcache: {
      note: '· Llama 3 8B on one 3g.40gb MIG slice · real time', label: 'MIG 3g.40gb · Llama 3 8B', narrow: '3g.40gb',
      aria: 'Animated simulation: Llama 3 8B on one MIG slice; its KV cache fills up and the scheduler preempts requests'
    },
    'mig-gpu': {
      note: '· three models on three H100s · real time', label: '3 × H100, one model each', narrow: '3 × H100',
      aria: 'Animated simulation: three models, each on its own H100'
    },
    'mig-time': {
      note: '· three models time-sharing one H100 · real time', label: 'one H100, time-sliced', narrow: 'shared H100',
      aria: 'Animated simulation: three models sharing one H100 by time-slicing, with no isolation'
    },
    'mig-mig': {
      note: '· three models on one H100 split 3g+2g+2g · real time', label: 'one H100 · MIG 3g+2g+2g', narrow: 'H100 · MIG',
      aria: 'Animated simulation: three models on isolated MIG slices of one H100'
    },
    'routing-onprem': {
      note: '· System1 model, Llama 3.2 1B and Llama 3 8B on one H100 · real time', label: 'one H100 · MIG 3g+2g+1g', narrow: 'H100 · MIG',
      aria: 'Animated simulation: a System1 model scores each request and routes it to a small or a large model on one H100'
    },
    'routing-api': {
      note: '· System1 model and Llama 3.2 1B on one H100, large model by API · real time', label: 'H100 + API model', narrow: 'H100 + API',
      aria: 'Animated simulation: a System1 model routes each request to a small model on one H100 or to a large model behind an API'
    }
  };
  var KV_MEM = 0.9;   // tab 02's slider default, vLLM's --gpu-memory-utilization default
  var ROUTE = E.PRESETS['routing-onprem'].routing.threshold;   // tab 04's slider default, the engine's

  var playBtn = $('sim-play'), burstBtn = $('sim-burst'), wrap503 = $('m-503-wrap'), wrapPre = $('m-pre-wrap');
  var wrapSmall = $('m-small-wrap'), wrapMis = $('m-mis-wrap'), wrapApi = $('m-api-wrap');
  var note = box.querySelector('.p-title .note'), kvMem = $('sim-kvmem'), kvMemOut = $('sim-kvmem-v');
  var route = $('sim-route'), routeOut = $('sim-route-v');
  var M = {
    p50: $('m-ttft50'), p99: $('m-ttft99'), tpot: $('m-tpot'), thr: $('m-thr'), kv: $('m-kv'),
    gpus: $('m-gpus'), cost: $('m-cost'), pre: $('m-pre'), rej: $('m-503'),
    small: $('m-small'), mis: $('m-mis'), api: $('m-api')
  };
  var tabs = [].slice.call(box.querySelectorAll('[role=tablist] [role=tab]'));
  var panels = [].slice.call(box.querySelectorAll('[role=tabpanel]'));
  // Each panel's radio group is its own roving-tabindex group
  function group(panelId) { return [].slice.call($(panelId).querySelectorAll('[role=radiogroup] [role=radio]')); }
  var batchRadios = group('sim-tab-batching'), deployRadios = group('sim-tab-mig'), largeRadios = group('sim-tab-routing');

  var sim = null, preset = null, V = null, L = null, frozen = REDUCE, shown = null;
  var W = 0, H = 0, visible = false, raf = 0, last = 0;

  // ---- Drawing helpers ----

  function mix(a, b, f) { return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; }
  // A queued request's colour by how long it has waited: base, warn at 500 ms, bad at 2 s
  function waitColor(w) {
    var c = w < 500 ? mix(BASE, WARN, Math.max(0, w) / 500) : mix(WARN, BAD, Math.min(1, (w - 500) / 1500));
    return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
  }
  function rr(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function bar(x, y, w, h, fill) {
    if (w <= 0) return;
    rr(x, y, w, h, Math.min(1.5, w / 2, h / 2)); ctx.fillStyle = fill; ctx.fill();
  }
  function text(s, x, y, size, color, align) {
    ctx.font = size + 'px ' + FONT; ctx.fillStyle = color; ctx.textAlign = align || 'left'; ctx.fillText(s, x, y);
  }
  function dotAt(x, y) { ctx.beginPath(); ctx.arc(x, y, DOT_R, 0, 6.283); ctx.fill(); }

  // ---- Layout ----

  // Fractions of W as in the approved mockup: arrivals 0-0.19, router and queue lanes 0.19-0.44,
  // GPU 0.49-0.84, token stream 0.84-1, and the sparkline strip along the bottom. Tab 04 has its own
  // layout (routingLayout).
  function layout() {
    var n = sim.instances.length, gap = 8, top = 26, bot = H - STRIP_H - 8, h = (bot - top - gap * (n - 1)) / n;
    L = { top: top, bot: bot, qx0: Math.round(W * 0.19), qx1: Math.round(W * 0.44), gx0: Math.round(W * 0.49), gx1: Math.round(W * 0.84), by: H - STRIP_H, boxes: [], routing: !!sim.routing };
    if (sim.routing) { routingLayout(gap); return; }
    for (var k = 0; k < n; k++) L.boxes.push(makeBox(L.gx0, L.gx1, top + k * (h + gap), h, L.qx0, L.qx1));
  }
  // Tab 04 runs left to right, as in the approved mockup: arrivals, the System1 box's queue lane, the System1
  // box (vertically centred), its two branches, then the 1B over the 8B (or the API model), each with its lane,
  // and the token stream. Fractions of W; on phones (560px and under) the arrivals, lanes and stream shrink, so
  // the boxes keep room for their headers.
  var ROUTING = {
    wide: { q1: [0.11, 0.19], s1: [0.21, 0.39], q2: [0.52, 0.59], box: [0.61, 0.89] },
    narrow: { q1: [0.06, 0.13], s1: [0.165, 0.4], q2: [0.535, 0.59], box: [0.625, 0.975] }
  };
  function routingLayout(gap) {
    var f = ROUTING[W <= 560 ? 'narrow' : 'wide'], h = (L.bot - L.top - gap) / 2;
    function x(v) { return Math.round(W * v); }
    var s1 = makeBox(x(f.s1[0]), x(f.s1[1]), L.top + (h + gap) / 2, h, x(f.q1[0]), x(f.q1[1]));
    s1.alone = true;   // its header isn't like the others', so it picks its own level
    L.boxes.push(s1);
    for (var k = 0; k < 2; k++) L.boxes.push(makeBox(x(f.box[0]), x(f.box[1]), L.top + k * (h + gap), h, x(f.q2[0]), x(f.q2[1])));
    L.gx0 = L.boxes[1].x; L.gx1 = L.boxes[1].x + L.boxes[1].w;
  }
  // A box from x0 to x1, h tall at y, with its queue lane from qx0 to qx1
  function makeBox(x0, x1, y, h, qx0, qx1) {
    var b = { x: x0, y: y, w: x1 - x0, h: h, qx0: qx0, qx1: qx1 };
    b.bx = b.x + 8; b.bw = b.w - 16; b.rowTop = b.y + 18;
    b.cap = Math.max(1, Math.floor((b.y + h - 14 - b.rowTop + ROW_GAP) / (ROW_H + ROW_GAP)));   // rows that fit
    b.qrows = Math.max(1, Math.floor((h - 8) / CELL));
    b.qcols = Math.max(1, Math.floor((qx1 - qx0) / CELL));
    return b;
  }
  // Tab 04's branch to box k (1 or 2): a curve from the middle of the System1 box's right edge to the door
  // of box k's lane (or to the API box, which has none), leaving and arriving level: [x0, y0, the two control
  // points, x1, y1], flat
  function branch(k) {
    var s = L.boxes[0], b = L.boxes[k], x0 = s.x + s.w, y0 = s.y + s.h / 2;
    var x1 = sim.instances[k].api ? b.x : b.qx0 - 6, y1 = b.y + b.h / 2, c = (x1 - x0) * 0.45;
    return [x0, y0, x0 + c, y0, x1 - c, y1, x1, y1];
  }
  function bezier(g, u) {
    var v = 1 - u, a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
    return [a * g[0] + b * g[2] + c * g[4] + d * g[6], a * g[1] + b * g[3] + c * g[5] + d * g[7]];
  }
  // A scored request's trip to box k, for its dot or its 503's red dot p: straight from where p is to the
  // System1 box's exit, then along the branch to the lane's door, HOP_MS in all
  function startHop(p, k) {
    var g = branch(k), a = Math.abs(g[0] - p.x) + Math.abs(g[1] - p.y), c = Math.abs(g[6] - g[0]) + Math.abs(g[7] - g[1]);
    p.hop = { k: k, sx: p.x, sy: p.y, u: 0, split: a / (a + c) || 0 };
  }
  // Moves p dt further on its trip; false once it has arrived
  function stepHop(p, dt) {
    var h = p.hop, g = branch(h.k), pt;
    h.u = Math.min(1, h.u + dt / HOP_MS);
    if (h.u < h.split) pt = [h.sx + (g[0] - h.sx) * h.u / h.split, h.sy + (g[1] - h.sy) * h.u / h.split];
    else pt = bezier(g, h.split < 1 ? (h.u - h.split) / (1 - h.split) : 1);
    p.x = pt[0]; p.y = pt[1];
    if (h.u >= 1) delete p.hop;
    return !!p.hop;
  }
  // Rows drawn out of n: all of them while they fit, else all but the last two lines, which hold "+N more"
  function drawn(b, n) { return n > b.cap ? Math.max(0, b.cap - 2) : n; }
  function lineY(b, j) { return b.rowTop + j * (ROW_H + ROW_GAP); }
  // Row j's top out of n rows; the rows under "+N more" wait behind the last drawn one
  function rowY(b, j, n) { return lineY(b, Math.max(0, Math.min(j, drawn(b, n) - 1))); }
  // Queue slot i of an instance's lane, oldest first, filling columns top to bottom
  function qslot(b, i) {
    var col = Math.min(Math.floor(i / b.qrows), b.qcols - 1), row = i % b.qrows;
    return [b.qx0 + col * CELL + CELL / 2, b.y + 4 + row * CELL + CELL / 2];
  }
  function prefillW(b, r) { return Math.max(3, b.bw * 0.25 * Math.min(1, r.prefillTarget / 4000)); }
  function decodeW(b, pw, tokens) { return Math.min(b.bw - pw - 1.5, b.bw * Math.min(1, tokens / 1000)); }

  // ---- View state: what the canvas shows, eased towards the engine's state ----

  function freshView() {
    var zeros = sim.instances.map(function () { return 0; }), models = {};
    sim.instances.forEach(function (inst) { models[inst.model] = true; });
    return {
      api: sim.instances.some(function (inst) { return inst.api; }),   // tab 04's API mode
      // the models with a target and a box: tab 04's targets also name the large model of the other mode
      targets: Object.keys(sim.slo || {}).filter(function (model) { return models[model]; }),
      vt: 0,              // frame clock (ms); it runs on after the sim's clock stops
      place: true,        // the next sync puts everything at its target instead of easing there
      dots: {},           // request id -> a dot for a queued request, or one flying to its row
      rows: sim.instances.map(function () { return []; }),   // per instance: { r, y, gen, doneAt, flew, pre, preAt }
      rate: zeros.slice(), acc: zeros.slice(),               // per instance: tok/s (smoothed), particle debt
      fly: [], toks: [], rejects: [],                        // finished requests, token particles, 503s
      hist: [], nextSample: SAMPLE_MS, rejected: 0,
      multi: Object.keys(models).length > 1,                 // several models: each box names its model
      p99: {},                                               // model -> TTFT p99 over P99_WINDOW_MS (tabs 03, 04), per footer refresh
      spend: null                                            // tab 04's API mode: the API model's $/h, per footer refresh
    };
  }

  function flyOut(b, row) {
    if (V.fly.length > 60) return;
    var pw = prefillW(b, row.r);
    V.fly.push({ x: b.bx + pw + 1.5 + decodeW(b, pw, row.r.generated), y: row.y + ROW_H / 2, vx: 170 + Math.random() * 90 });
  }
  // A 503's red dot, from (x, y) to the door of box b's queue lane, where it fades
  function reject(x, y, b) { return { x: x, y: y, tx: b.qx0 - 12, ty: b.y + 6 + Math.random() * (b.h - 12), age: 0 }; }
  function tokenOut(b, rows) {
    if (V.toks.length > 120) return;
    var vis = drawn(b, rows.length);   // from a drawn row, not from under "+N more"
    var y = vis ? rows[Math.floor(Math.random() * vis)].y + ROW_H / 2 : b.y + b.h / 2;
    V.toks.push({ x: b.x + b.w + 2, y: y, vx: 110 + Math.random() * 80 });
  }

  function sync(dt) {
    var k = V.place ? 1 : Math.min(1, dt / 1000 * 9), seen = {};
    function dot(r, tx, ty, lands, fade, ii) {
      var d = V.dots[r.id], g;
      // tab 04: a request first seen at a model's box was scored between two frames, so its dot starts at the
      // System1 box's exit, as from there (inst 0), and takes its branch like the others
      if (!d && !V.place && L.routing && ii > 0) { g = branch(ii); d = V.dots[r.id] = { x: g[0], y: g[1], inst: 0 }; }
      if (!d) d = V.dots[r.id] = V.place ? { x: tx, y: ty, inst: ii } : { x: -4, y: L.top + Math.random() * (L.bot - L.top), inst: ii };
      if (V.place) delete d.hop;
      else if (L.routing && d.inst === 0 && ii > 0) startHop(d, ii);   // tab 04: just scored, so off down its branch
      d.inst = ii;
      if (d.hop && stepHop(d, dt)) d.landed = false;
      else {
        d.x += (tx - d.x) * k; d.y += (ty - d.y) * k;
        if (!lands) d.landed = false;
        else if (d.landed || Math.abs(tx - d.x) + Math.abs(ty - d.y) < 3) { d.landed = true; d.x = tx; d.y = ty; }
      }
      d.r = r; d.tx = tx; d.ty = ty; d.fade = !!fade;
      seen[r.id] = true;
    }
    sim.instances.forEach(function (inst, ii) {
      var b = L.boxes[ii], rows = V.rows[ii], live = {}, have = {}, made = 0, j, row, r, ty;
      var vis = drawn(b, rows.length);   // rows drawn; the rest are "+N more"
      inst.running.forEach(function (x) { live[x.id] = x; });
      for (j = rows.length - 1; j >= 0; j--) {
        row = rows[j]; r = row.r;
        if (r.inst === ii) made += r.generated - row.gen;   // tab 04: a scored request's tokens are its next box's
        row.gen = r.generated;
        if (r.tDone !== null && row.doneAt === null) row.doneAt = V.vt;
        if (r.preemptions > row.pre && row.preAt === null) {
          if (j < vis) row.preAt = V.vt;   // preempted: a drawn row flashes amber before it leaves
          else row.pre = r.preemptions;    // a row under "+N more" just goes (or stays, if already readmitted)
        }
        if (row.preAt !== null && V.vt - row.preAt >= FLASH_MS) {
          row.pre = r.preemptions; row.preAt = null;   // flashed: it leaves below, unless already readmitted
        }
        if (row.doneAt !== null && !row.flew && V.vt - row.doneAt >= FLASH_MS) {
          row.flew = true;
          if (j < vis) flyOut(b, row);   // a row under "+N more" was never drawn, so nothing flies out of it
        }
        if (live[r.id] === r) have[r.id] = true;              // running, or an idle slot of a request-level batch
        else if (row.preAt === null && (row.doneAt === null || row.flew)) rows.splice(j, 1);   // preempted and flashed, or finished and flown out
      }
      inst.running.forEach(function (x) {
        if (!have[x.id]) rows.push({ r: x, y: null, gen: x.generated, doneAt: x.tDone !== null ? -Infinity : null, flew: x.tDone !== null, pre: x.preemptions, preAt: null });
      });
      vis = drawn(b, rows.length);
      for (j = 0; j < rows.length; j++) {
        row = rows[j]; ty = rowY(b, j, rows.length);
        row.y = row.y === null ? ty : row.y + (ty - row.y) * k;   // a new row starts in its place
        // a row under "+N more" isn't drawn, so its dot fades out before it reaches the box, clear of the label.
        // A flashing preempted row keeps its dot; once the row goes, the dot eases back to the queue front.
        if (live[row.r.id] === row.r || row.preAt !== null) dot(row.r, b.bx + 2, ty + ROW_H / 2, true, j >= vis, ii);
      }
      inst.queue.forEach(function (x, qi) { if (!seen[x.id]) { var p = qslot(b, qi); dot(x, p[0], p[1], false, false, ii); } });
      if (dt > 0) {   // token particles: scaled to the instance's tok/s, at most 30 a second
        V.rate[ii] += (made * 1000 / dt - V.rate[ii]) * Math.min(1, dt / 600);
        V.acc[ii] += Math.min(MAX_PARTICLES_PER_S, V.rate[ii] / TOKENS_PER_PARTICLE) * dt / 1000;
        for (; V.acc[ii] >= 1; V.acc[ii] -= 1) tokenOut(b, rows);
      }
    });
    // 503s: the router had nowhere to send them, so they stop at the first box's lane. In tab 04 a request
    // the System1 model scored can also be turned away by the model it was sent to: it goes from where its
    // dot was down its branch to that box's lane.
    var turnedAway = sim.stats.rejected - V.rejected, q, to = 0;
    function turnAway(x, y, k) {
      var p = reject(x, y, L.boxes[k]);
      if (L.routing && k > 0) startHop(p, k);
      V.rejects.push(p);
    }
    V.rejected = sim.stats.rejected;
    for (var id in V.dots) {
      if (seen[id]) continue;
      var d = V.dots[id];
      delete V.dots[id];
      if (d.r.state !== 'rejected') continue;
      for (q = 0; q < sim.instances.length && sim.instances[q].model !== d.r.model; q++);
      if (q === sim.instances.length) continue;
      turnedAway -= 1;
      if (!V.place) turnAway(d.x, d.y, q);
    }
    // A 503 the page never saw queue (scored and turned away between two frames) met a full queue: in tab 04,
    // the longest one, and from a model's lane it starts down that branch
    for (q = 1; L.routing && q < sim.instances.length; q++) if (sim.instances[q].queue.length > sim.instances[to].queue.length) to = q;
    for (q = 0; !V.place && q < Math.min(turnedAway, 8); q++) {
      if (to) turnAway(branch(to)[0], branch(to)[1], to);
      else turnAway(-4, L.top + Math.random() * (L.bot - L.top), 0);
    }
    var s = dt / 1000;
    V.fly = V.fly.filter(function (p) { p.x += p.vx * s; return p.x < W + 30; });
    V.toks = V.toks.filter(function (p) { p.x += p.vx * s; return p.x < W + 6; });
    V.rejects = V.rejects.filter(function (p) {
      p.age += dt;
      if (!(p.hop && stepHop(p, dt))) { p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k; }
      return p.age < 900;
    });
    V.place = false;
  }

  function animating() {
    if (V.fly.length || V.toks.length || V.rejects.length) return true;
    for (var i = 0; i < V.rows.length; i++) if (V.rows[i].length) return true;
    return false;
  }

  // ---- Drawing ----

  // One sequence: a prefill block (filled as its chunks run), then the decode part, one token per step
  function drawRow(inst, b, row) {
    var r = row.r, x = b.bx, y = row.y, pw = prefillW(b, r);
    var flash = row.doneAt !== null && V.vt - row.doneAt < FLASH_MS;
    if (row.preAt !== null) {   // preempted: its KV is gone, and it will redo its prefill from the queue
      bar(x, y, pw, ROW_H, COL.warn);
      bar(x + pw + 1.5, y, decodeW(b, pw, r.generated), ROW_H, COL.preDecode);
    } else if (flash) {
      bar(x, y, pw, ROW_H, COL.ok);
      bar(x + pw + 1.5, y, decodeW(b, pw, r.generated), ROW_H, COL.doneDecode);
    } else if (r.state === 'idle') {
      // a finished sequence still holds its slot, and the batch keeps stepping it until the slowest one ends
      var dw = decodeW(b, pw, Math.max(r.generated, E.slotSteps(inst)));
      bar(x, y, pw, ROW_H, COL.idle);
      bar(x + pw + 1.5, y, dw, ROW_H, COL.idle);
    } else {
      var pf = E.prefillProgress(sim, inst, r);
      if (pf < 1) bar(x, y, pw, ROW_H, COL.prefillTodo);
      bar(x, y, pw * pf, ROW_H, COL.accent);
      bar(x + pw + 1.5, y, decodeW(b, pw, r.generated), ROW_H, COL.decode);
    }
  }

  // A box's name: a whole H100 as itself, numbered when there are several, or shared when time-sliced;
  // a MIG slice by its profile
  function boxName(inst) {
    if (inst.profile !== '7g.80gb') return inst.profile;
    return inst.timeSliced ? 'shared H100' : sim.gpuCount > 1 ? 'H100 ' + (inst.gpu + 1) : 'H100';
  }
  function width(pieces) {
    var w = 0;
    for (var k = 0; k < pieces.length; k++) w += ctx.measureText(pieces[k][0]).width;
    return w;
  }
  // A box's header: its name on the left; on the right a time-sliced step's stretch (×2, ×3), then in
  // tabs 03 and 04 the model's p99 against its SLO ("p99 1.84s / 2s", the p99 green or red), else the
  // running count, then KV. levels runs from the fullest header to the barest: pieces drop from the right
  // (KV, then "p99 " and the spaces around the slash), and last the name gives way to just the model. A
  // time-sliced box always keeps room for its marker, so nothing shifts as it blinks.
  // In tab 04 the System1 box reads "System1 · scoring" with its queue and running counts and no p99, since
  // its one token is a score no user sees; the API box names the API model's spend (in whole dollars on
  // phones, before it gives way to just "API"), and shows its requests in flight where the others show KV.
  function header(inst) {
    var kv = inst.kvBudget > 0 ? inst.kvUsed / inst.kvBudget : 0, hot = kv > 0.8, n = 0, fits, levels;
    var kvTxt = 'KV ' + Math.round(kv * 100) + '%', kvCol = hot ? COL.warn : COL.muted;
    var short = E.MODELS[inst.model].short, target = sim.slo ? sim.slo[inst.model] : undefined;
    inst.running.forEach(function (r) { if (r.state === 'running') n += 1; });
    if (inst.model === 'system1') {
      var q = inst.queue.length, brief = [['q ' + q + ' · run ' + n, COL.muted]];
      levels = [['System1 · scoring', [['queue ' + q + ' · running ' + n, COL.muted]]],
                ['System1 · scoring', brief], ['System1', brief], [short, brief], [short, [['q ' + q, COL.muted]]]];
    } else {
      var last = inst.api ? [' · ' + n + ' in flight', COL.muted] : [' · ' + kvTxt, kvCol];
      if (target !== undefined) {
        var p = V.p99[inst.model], v = E.fmt.ms(p === undefined ? null : p), slo = E.fmt.slo(target);
        var pCol = p === null || p === undefined ? COL.muted : p <= target ? COL.ok : COL.bad;
        fits = [[['p99 ' + v, pCol], [' / ' + slo, COL.muted], last],
                [['p99 ' + v, pCol], [' / ' + slo, COL.muted]],
                [[v, pCol], ['/' + slo, COL.muted]]];
      } else {
        fits = [[['running ' + n + ' · ' + kvTxt, kvCol]], [[n + ' · ' + kvTxt, kvCol]]];
      }
      var name = inst.api ? 'API model · ' + perHour(V.spend) : V.multi ? boxName(inst) + ' · ' + short : boxName(inst);
      levels = fits.map(function (f) { return [name, f]; });
      // the API box's phone step, its spend in whole dollars; the other boxes keep their name for that step
      if (V.api) levels.push(inst.api ? ['API ' + (V.spend === null ? '\u2013' : '$' + Math.round(V.spend) + '/h'), fits[fits.length - 1]] : levels[levels.length - 1]);
      if (V.multi) levels.push([short, fits[fits.length - 1]]);
    }
    ctx.font = '9px ' + FONT;
    return {
      kv: kv, hot: hot, levels: levels,
      marker: E.stretchNow(inst) > 1 ? ['×' + E.stretchNow(inst) + ' ', COL.warn] : null,
      room: inst.timeSliced ? ctx.measureText('×0 ').width : 0
    };
  }
  // The first level whose header fits its box (the last one if none does)
  function fitLevel(h, b) {
    ctx.font = '9px ' + FONT;
    for (var k = 0; k < h.levels.length - 1; k++) {
      if (ctx.measureText(h.levels[k][0]).width + h.room + width(h.levels[k][1]) + 24 <= b.w) return k;
    }
    return h.levels.length - 1;
  }
  // At the level draw() picks for every box; a box with fewer levels stays at its barest
  function drawHeader(h, level, b) {
    var lv = h.levels[Math.min(level, h.levels.length - 1)];
    var right = (h.marker ? [h.marker] : []).concat(lv[1]), x = b.x + b.w - 7;
    text(lv[0], b.x + 7, b.y + 12, 9, COL.muted);
    for (var k = right.length - 1; k >= 0; k--) {   // right-aligned, last piece first
      text(right[k][0], x, b.y + 12, 9, right[k][1], 'right');
      x -= ctx.measureText(right[k][0]).width;
    }
  }

  // A box and its queue lane. Tab 04's API box is dashed, on someone else's GPUs, with neither a lane nor a
  // KV bar, and no free slot: the API model starts every request the moment it's routed there.
  function drawInstance(inst, b, rows, h, level) {
    ctx.lineWidth = 1;
    if (!inst.api) {
      ctx.strokeStyle = COL.lane; ctx.setLineDash([3, 4]);
      rr(b.qx0 - 6, b.y, b.qx1 - b.qx0 + 12, b.h, 6); ctx.stroke(); ctx.setLineDash([]);
    }

    rr(b.x, b.y, b.w, b.h, 6);
    if (inst.api) {
      ctx.fillStyle = COL.panel; ctx.fill(); ctx.strokeStyle = COL.muted; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    } else {
      ctx.fillStyle = COL.box; ctx.fill(); ctx.strokeStyle = COL.line; ctx.stroke();
    }
    var kv = h.kv, hot = h.hot;
    drawHeader(h, level, b);

    var show = drawn(b, rows.length);
    for (var j = 0; j < show; j++) drawRow(inst, b, rows[j]);
    if (rows.length > b.cap) {   // on its own line below the last drawn row (two row lines tall)
      text('+' + (rows.length - show) + ' more', b.bx, lineY(b, show) + 7.5, 8, COL.faint);
    } else if (!inst.api && rows.length < b.cap && E.canAdmit(sim, inst)) {   // a free slot: the next request to arrive joins at the next step
      ctx.strokeStyle = COL.free; ctx.setLineDash([2, 2]);
      rr(b.bx + 0.5, lineY(b, rows.length) + 0.5, b.bw * 0.22, ROW_H - 1, 1.5); ctx.stroke(); ctx.setLineDash([]);
    }

    if (inst.api) return;
    var ky = b.y + b.h - 8;
    bar(b.bx, ky, b.bw, 3, COL.track);
    bar(b.bx, ky, b.bw * Math.min(1, kv), 3, hot ? COL.warn : COL.accent);
  }

  function drawDots() {
    for (var id in V.dots) {
      var d = V.dots[id];
      var a = d.fade ? Math.max(0, Math.min(1, (Math.abs(d.tx - d.x) + Math.abs(d.ty - d.y) - FADE_NEAR) / FADE_SPAN)) : 1;
      if (d.landed || !a) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = d.r.state === 'queued' ? waitColor(sim.t - d.r.t0) : COL.accent;
      dotAt(d.x, d.y);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = COL.bad;
    V.rejects.forEach(function (p) {
      ctx.globalAlpha = p.age < 500 ? 1 : Math.max(0, 1 - (p.age - 500) / 400);
      dotAt(p.x, p.y);
    });
    ctx.globalAlpha = 1;
  }

  function drawStream() {
    var span = Math.max(1, W - L.gx1);
    ctx.fillStyle = COL.ok;
    V.toks.forEach(function (p) {
      ctx.globalAlpha = 0.85 * Math.max(0, Math.min(1, (W - p.x) / span * 1.6));
      ctx.fillRect(p.x, p.y - 1.5, 3, 3);
    });
    V.fly.forEach(function (p) {
      for (var q = 1; q <= 3; q++) { ctx.globalAlpha = 0.5 - q * 0.12; ctx.fillRect(p.x - q * 6 - 2, p.y - 1, 3.5, 2); }
      ctx.globalAlpha = 1;
      dotAt(p.x, p.y);
    });
    ctx.globalAlpha = 1;
  }

  // Rolling TTFT p99, one sample every 300 ms of sim time, with a dashed marker per switch
  function drawStrip() {
    var by = L.by, x0 = 72, x1 = W - 10, h = V.hist, n = h.length, mx = 250, i, pen = false;
    ctx.strokeStyle = COL.sep; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, by + 0.5); ctx.lineTo(W, by + 0.5); ctx.stroke();
    text('TTFT p99', 10, by + 11, 9, COL.faint);
    text('rolling', 10, by + 21, 9, COL.faint);
    if (n < 2) return;
    function xs(j) { return x0 + (x1 - x0) * Math.min(1, j / (SAMPLES - 1)); }
    function ys(v) { return by + 23 - Math.min(1, v / mx) * 18; }
    for (i = 0; i < n; i++) if (h[i].v !== null && h[i].v * 1.15 > mx) mx = h[i].v * 1.15;
    ctx.beginPath();
    for (i = 0; i < n; i++) {
      if (h[i].v === null) { pen = false; continue; }
      if (pen) ctx.lineTo(xs(i), ys(h[i].v)); else ctx.moveTo(xs(i), ys(h[i].v));
      pen = true;
    }
    ctx.strokeStyle = COL.accent; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;

    // A dashed line and a label per marker. Markers close enough for their labels to collide (tab 04's slider
    // stepped key by key) form a run, and only the run's newest marker is drawn. Lines go first, so a label sits
    // on top of any line.
    var marks = [], placed = [];
    ctx.font = '8px ' + FONT;
    sim.events.forEach(function (ev) {
      if (ev.t < h[0].t) return;   // scrolled off the left
      for (i = 0; i < n && h[i].t < ev.t; i++);
      var x = Math.round(xs(Math.min(i, n - 1))) + 0.5, w = ctx.measureText(ev.label).width;
      marks.push({ label: ev.label, x: x, w: w, lx: x + 5 + w > x1 ? x - 5 - w : x + 5 });
    });
    function clash(a, b) { return a.lx < b.lx + b.w + 8 && b.lx < a.lx + a.w + 8; }
    for (i = marks.length - 1; i >= 0; i--) {
      var m = marks[i];
      if (!(i + 1 < marks.length && clash(m, marks[i + 1])) && !placed.some(function (p) { return clash(m, p); })) placed.push(m);
    }
    ctx.strokeStyle = COL.ok; ctx.setLineDash([2, 2]);
    placed.forEach(function (m) { ctx.beginPath(); ctx.moveTo(m.x, by + 3); ctx.lineTo(m.x, by + 25); ctx.stroke(); });
    ctx.setLineDash([]);
    placed.forEach(function (m) {
      ctx.fillStyle = COL.panel;   // the label sits on a patch of panel, so no line runs through it
      ctx.fillRect(m.lx - 2, by + 4, m.w + 4, 9);
      text(m.label, m.lx, by + 11, 8, COL.ok);
    });
  }

  // Tab 04's column labels, the most telling first; one that would run into a label already drawn is left out
  function routingLabels(narrow) {
    var s1 = L.boxes[0], b = L.boxes[1], taken = [];
    ctx.font = '10px ' + FONT;
    [[narrow ? VIEWS[preset].narrow : VIEWS[preset].label, b.x], [narrow ? 'router' : 'router · ' + sim.instances[0].profile, s1.x],
     ['queue', s1.qx0 - 4], ['queues', b.qx0 - 4], ['requests →', 10], ['tokens →', b.x + b.w + 10]].forEach(function (l) {
      var x0 = l[1], x1 = x0 + ctx.measureText(l[0]).width;
      if (x1 > W - 4 || taken.some(function (t) { return x0 < t[1] + 6 && t[0] < x1 + 6; })) return;
      taken.push([x0, x1]);
      text(l[0], x0, 16, 10, COL.faint);
    });
  }
  // Tab 04's two branches out of the System1 box, labelled with the routing rule at the live threshold: above
  // the branch to the small model and below the one to the large model, or just "< 0.45" and "≥ 0.45" where
  // the whole rule doesn't fit between the System1 box and the lanes. At 1 the gateway sends nothing large,
  // not even a score of 1, so the labels say so.
  function drawBranches() {
    var t = sim.routing.threshold.toFixed(2), g = [branch(1), branch(2)], room = g[0][6] - g[0][0];
    var rules = sim.routing.threshold >= 1 ? [['all → small', 'all'], ['none → large', 'none']] :
      [['score < ' + t + ' → small', '< ' + t], ['score ≥ ' + t + ' → large', '≥ ' + t]];
    ctx.strokeStyle = COL.branch; ctx.lineWidth = 1.5;
    g.forEach(function (p) { ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.bezierCurveTo(p[2], p[3], p[4], p[5], p[6], p[7]); ctx.stroke(); });
    ctx.lineWidth = 1;
    ctx.font = '9px ' + FONT;
    var whole = Math.max(ctx.measureText(rules[0][0]).width, ctx.measureText(rules[1][0]).width) + 16 <= room;
    rules.forEach(function (rule, i) {
      var s = whole ? rule[0] : rule[1], w = ctx.measureText(s).width;
      text(s, g[0][0] + Math.min(8, (room - w) / 2), i ? g[1][7] + 13 : g[0][7] - 6, 9, COL.muted);
    });
  }

  function draw() {
    if (!W || !L) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = COL.grid;
    for (var gx = 8; gx < W; gx += 16) for (var gy = 8; gy < L.bot + 4; gy += 16) ctx.fillRect(gx, gy, 1, 1);
    var narrow = W <= 560;
    ctx.font = '10px ' + FONT;
    if (L.routing) {
      routingLabels(narrow);
      drawBranches();
    } else {
      text(10 + ctx.measureText('requests →').width + 6 > L.qx0 - 4 ? 'requests' : 'requests →', 10, 16, 10, COL.faint);
      text(narrow ? 'queue' : 'router · queue', L.qx0 - 4, 16, 10, COL.faint);
      text(narrow ? VIEWS[preset].narrow : VIEWS[preset].label, L.gx0, 16, 10, COL.faint);
      if (W > 420) text('tokens →', L.gx1 + 10, 16, 10, COL.faint);
    }
    // every box's header at the same level, so their names and pieces match (tab 04's System1 box has its own)
    var heads = sim.instances.map(header), level = 0;
    heads.forEach(function (h, ii) { if (!L.boxes[ii].alone) level = Math.max(level, fitLevel(h, L.boxes[ii])); });
    sim.instances.forEach(function (inst, ii) {
      var b = L.boxes[ii];
      drawInstance(inst, b, V.rows[ii], heads[ii], b.alone ? fitLevel(heads[ii], b) : level);
    });
    drawDots();
    drawStream();
    drawStrip();
  }

  // ---- Footer and play button ----

  // The canvas's aria-label in tabs 03 and 04: the view, then each model's p99 against its target, as the boxes show it
  function sloLabel() {
    return VIEWS[preset].aria + '. ' + V.targets.map(function (model) {
      var p = V.p99[model], slo = sim.slo[model];
      return E.MODELS[model].short + ' p99 ' + E.fmt.spoken(p) + ', target ' + E.fmt.spoken(slo) +
        (p === null ? '' : p <= slo ? ', met' : ', missed');
    }).join('; ');
  }
  // A spend per hour, as the footer and the API box show it: '$60.12/h', or a dash with no API model
  function perHour(v) { return v === null ? '\u2013' : '$' + v.toFixed(2) + '/h'; }
  function footer() {
    var m = E.metrics(sim), f = E.fmt;
    if (sim.slo) {   // each box's p99 against its SLO, refreshed with the footer, and the same in words
      V.targets.forEach(function (model) { V.p99[model] = E.metrics(sim, model, P99_WINDOW_MS).ttftP99; });
      var label = sloLabel();
      if (cv.getAttribute('aria-label') !== label) cv.setAttribute('aria-label', label);
    }
    M.p50.textContent = f.ms(m.ttftP50);
    M.p99.textContent = f.ms(m.ttftP99);
    M.tpot.textContent = f.ms(m.tpotMs);
    M.thr.textContent = f.tok(m.tokPerSec);
    M.kv.textContent = f.pct(m.kvFrac);
    M.gpus.textContent = sim.gpuCount;
    M.cost.textContent = f.usd(m.costPer1M);
    M.pre.textContent = sim.stats.preemptions.toLocaleString('en-US');
    wrapPre.hidden = !(sim.stats.preemptions > 0);
    M.rej.textContent = m.rejected.toLocaleString('en-US');
    wrap503.hidden = !(m.rejected > 0);
    // tab 04: the routing shares, and in API mode the API model's spend
    wrapSmall.hidden = wrapMis.hidden = !sim.routing;
    wrapApi.hidden = !V.api;
    if (sim.routing) { M.small.textContent = f.pct(m.smallShare); M.mis.textContent = f.pct(m.misroutedShare); }
    V.spend = m.apiUsdPerHour;   // and the API box's header
    if (V.api) M.api.textContent = perHour(V.spend);
    return m;
  }
  function sample(m) {
    V.hist.push({ t: sim.t, v: m.ttftP99 });
    if (V.hist.length > SAMPLES) V.hist.shift();
  }

  function renderPlay() {
    var st = E.playState(sim, frozen);
    if (st === shown) return;
    shown = st;
    playBtn.textContent = PLAY[st][0];
    playBtn.setAttribute('aria-label', PLAY[st][1]);
    box.classList.toggle('paused', st === 'stopped');
    if (st === 'stopped') footer();   // the last numbers before the sim's clock stops
  }

  // ---- Loop ----

  // Once drained, the sim's clock stops; the frame clock runs on until the last row and particle are gone
  function step(dt) {
    if (E.playState(sim, frozen) !== 'stopped') E.tick(sim, dt);
    V.vt += dt;
    sync(dt);
    if (sim.t >= V.nextSample) { V.nextSample += SAMPLE_MS; sample(footer()); }
    renderPlay();
  }
  function live() { return !frozen && (E.playState(sim, false) !== 'stopped' || animating()); }
  function frame(now) {
    raf = 0;
    if (!visible || document.hidden) { last = 0; return; }
    var dt = last ? Math.min(50, now - last) : 16;
    last = now;
    step(dt);
    draw();
    if (live()) raf = requestAnimationFrame(frame);
  }
  function wake() {
    if (!raf && visible && !document.hidden && live()) { last = 0; raf = requestAnimationFrame(frame); }
  }

  // Sizes the canvas's pixels to its box; returns whether anything changed
  function measure() {
    var r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!r.width || (r.width === W && r.height === H && cv.width === Math.round(W * dpr))) return false;
    W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }
  function resize() {
    if (!measure() || !sim) return;
    layout(); V.place = true; sync(0); draw();
  }

  // ---- Tabs and controls ----

  // Checks the radio that matches, and makes it the one Tab stops on in its group
  function check(list, attr, value) {
    list.forEach(function (b) {
      var on = b.getAttribute(attr) === value;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
  }
  // Batching follows the sim; the deployment and the large model follow the preset, MIG while tab 03
  // isn't open and on-prem while tab 04 isn't
  function syncRadios() {
    check(batchRadios, 'data-batching', sim.batching);
    check(deployRadios, 'data-deploy', preset.indexOf('mig-') === 0 ? preset.slice(4) : 'mig');
    check(largeRadios, 'data-large', preset.indexOf('routing-') === 0 ? preset.slice(8) : 'onprem');
  }

  // A redeploy: builds the preset with a fresh seed and warms it up, so it opens mid-flow (tabs 03 and 04,
  // whose boxes show a 30 s p99, for longer). Tab 04 starts at the slider's threshold, so a mode switch keeps
  // it, from the warm-up on and with no marker. Nothing of the old sim's view carries over, and frozen stays
  // as it is (reduced motion opens every one frozen).
  function deploy(id, config) {
    var p = E.PRESETS[id];
    preset = id;
    sim = E.createSim(Object.assign({}, p, {
      seed: Math.floor(Math.random() * 2147483647), config: config,
      routing: p.routing ? Object.assign({}, p.routing, { threshold: +route.value }) : null
    }));
    V = freshView();
    for (var k = 0, n = sim.slo ? TAB03_WARMUP_TICKS : WARMUP_TICKS; k < n; k++) {
      E.tick(sim, TICK_MS);
      if (sim.t >= V.nextSample) { V.nextSample += SAMPLE_MS; sample(E.metrics(sim)); }
    }
    V.rejected = sim.stats.rejected;
    note.textContent = VIEWS[id].note;
    cv.setAttribute('aria-label', VIEWS[id].aria);
    // blended in API mode: the H100 plus the API model's tokens
    M.cost.parentNode.title = 'per 1M output tokens · H100 at $' + E.GPU_HOUR_USD.toFixed(2) + '/h · ' + E.GPU_HOUR_SOURCE +
      (V.api ? ' · plus the API model at $' + E.API.inputPer1M.toFixed(2) + ' / $' + E.API.outputPer1M.toFixed(2) +
               ' per 1M input / output tokens · ' + E.API_SOURCE : '');
    syncRadios();
    shown = null;
    cv.classList.toggle('tall', sim.instances.length >= TALL_AT);   // 320px (300px on phones) for three boxes
    measure();
    L = null;
    if (W) { layout(); sync(0); }
    footer();
    renderPlay();
    draw();
    wake();
  }

  // Opens a tab with its controls at their defaults: continuous batching, the slider at 0.9, MIG, and
  // tab 04's threshold at the engine's default with the 8B on-prem
  function switchTab(id) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === id;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    panels.forEach(function (p) { p.hidden = p.getAttribute('data-tab') !== id; });
    kvMem.value = String(KV_MEM);
    kvMemOut.textContent = KV_MEM.toFixed(2);
    route.value = String(ROUTE);
    routeOut.textContent = ROUTE.toFixed(2);
    if (id === 'kvcache') deploy('kvcache', { gpuMemUtil: KV_MEM });
    else deploy(id === 'mig' ? 'mig-mig' : id === 'routing' ? 'routing-onprem' : 'batching');
  }

  function setMode(b) {
    E.setBatching(sim, b.getAttribute('data-batching'));
    syncRadios();
    if (!raf) draw();   // frozen or stopped: show the new marker now
  }
  function setDeploy(b) {
    var id = 'mig-' + b.getAttribute('data-deploy');
    if (id !== preset) deploy(id);
  }
  function setLarge(b) {
    var id = 'routing-' + b.getAttribute('data-large');
    if (id !== preset) deploy(id);   // at the slider's threshold
  }

  // Arrow keys move along a tab list or radio group and pick what they land on (roving tabindex)
  function arrows(list, keys, pick) {
    list.forEach(function (b, i) {
      b.addEventListener('keydown', function (e) {
        var d = keys[e.key];
        if (!d) return;
        e.preventDefault();
        var next = list[(i + d + list.length) % list.length];
        if (next !== b) { next.focus(); pick(next); }
      });
    });
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      if (t.getAttribute('aria-selected') !== 'true') switchTab(t.getAttribute('data-tab'));
    });
  });
  arrows(tabs, { ArrowLeft: -1, ArrowRight: 1 }, function (t) { switchTab(t.getAttribute('data-tab')); });
  var RADIO_KEYS = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
  batchRadios.forEach(function (b) { b.addEventListener('click', function () { setMode(b); }); });
  arrows(batchRadios, RADIO_KEYS, setMode);
  deployRadios.forEach(function (b) { b.addEventListener('click', function () { setDeploy(b); }); });
  arrows(deployRadios, RADIO_KEYS, setDeploy);
  largeRadios.forEach(function (b) { b.addEventListener('click', function () { setLarge(b); }); });
  arrows(largeRadios, RADIO_KEYS, setLarge);
  // The output follows the slider as it moves; a redeploy waits for the change (release, or a key step),
  // since --gpu-memory-utilization is a startup flag
  kvMem.addEventListener('input', function () { kvMemOut.textContent = (+kvMem.value).toFixed(2); });
  kvMem.addEventListener('change', function () {
    kvMemOut.textContent = (+kvMem.value).toFixed(2);
    deploy('kvcache', { gpuMemUtil: +kvMem.value });
  });
  // Tab 04's threshold is a router setting, so it moves live on the change: requests scored from then
  // on use it, and the sparkline marks it
  route.addEventListener('input', function () { routeOut.textContent = (+route.value).toFixed(2); });
  route.addEventListener('change', function () {
    routeOut.textContent = (+route.value).toFixed(2);
    E.setThreshold(sim, +route.value);
    if (!raf) draw();   // frozen or stopped: show the new marker now
  });

  // Pause stops new arrivals and lets in-flight work drain; play (also from draining) restarts them
  playBtn.addEventListener('click', function () {
    if (E.playState(sim, frozen) === 'running') E.setArrivals(sim, false);
    else { frozen = false; E.setArrivals(sim, true); }
    renderPlay();
    wake();
  });
  // A burst while stopped plays just that burst. A frozen start (reduced motion) still has arrivals
  // on from the warm-up, so they go off first: the button read "▶ play" and must keep meaning stopped.
  burstBtn.addEventListener('click', function () {
    if (frozen) { frozen = false; E.setArrivals(sim, false); }
    E.sendBurst(sim, BURST, 0);   // stream 0: tab 03's 8B, and in tab 04 the System1 model, so it's routed
    renderPlay();
    wake();
  });

  resize();
  switchTab('batching');
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(cv);
  else window.addEventListener('resize', resize);
  if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; wake(); }).observe(cv);
  else { visible = true; wake(); }
  document.addEventListener('visibilitychange', wake);
})();
