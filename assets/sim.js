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
// Tab 05 replays an hour of Azure's real traffic (assets/sim/azure-conv.json, fetched when the panel first
// comes into view) or random traffic at the same load; on the trace, the arrivals label is the trace's clock.
// Each tab's lesson line is one sentence; its "?" opens the full lesson in a popover placed under it.
// Clicking a request's dot or row follows it: it's outlined on the canvas, and the strip under the key shows
// its queue, prefill and decode spans, what happened to it, and its TTFT, TPOT and total time. The config
// drawer shows the setup being simulated, one block per server, with the value last changed highlighted.
// The sandbox builds a deployment from knobs or a terminal (both run the same commands), shows its config
// beside them, meters its cost, and runs the SLO challenge: the Azure hour's peak against that deployment.
// Tab 06 serves two replicas on two H100s: killing one draws its box failed (dashed red), and with the
// autoscaler on its replacement draws as starting (dashed, counting down its cold start) until it serves.
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
    lane: 'rgba(220,225,235,0.12)', grid: 'rgba(220,225,235,0.06)', branch: 'rgba(122,162,255,0.45)', badDim: 'rgba(239,68,68,0.5)'
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
    },
    'traffic-trace': {
      note: '· Llama 3 8B on one H100 · Azure trace, 1 h in 5 min', label: 'H100 · Llama 3 8B', narrow: 'H100',
      aria: 'Animated simulation: an hour of Azure\'s production LLM traffic, sped up 12 times, served by Llama 3 8B on one H100'
    },
    failure: {
      note: '· Llama 3 8B on two H100s · real time', label: '2 × H100 · Llama 3 8B', narrow: '2 × H100',
      aria: 'Animated simulation: Llama 3 8B on two H100 replicas behind a router; one can be killed and replaced'
    },
    'traffic-random': {
      note: '· Llama 3 8B on one H100 · random traffic · real time', label: 'H100 · Llama 3 8B', narrow: 'H100',
      aria: 'Animated simulation: random traffic at the Azure hour\'s average rate, served by Llama 3 8B on one H100'
    }
  };
  var KV_MEM = 0.9;   // tab 02's slider default, vLLM's --gpu-memory-utilization default
  var ROUTE = E.PRESETS['routing-onprem'].routing.threshold;   // tab 04's slider default, the engine's

  var playBtn = $('sim-play'), burstBtn = $('sim-burst');
  var wrapSmall = $('m-small-wrap'), wrapMis = $('m-mis-wrap'), wrapApi = $('m-api-wrap'), wrapRetry = $('m-retry-wrap');
  var killBtn = $('sim-kill');
  var followEl = $('sim-follow'), flWhat = $('fl-what'), flNums = $('fl-nums'), flNext = $('fl-next'), flStop = $('fl-stop');
  var flNote = $('fl-note'), flRows = [].slice.call(followEl.querySelectorAll('.fl-row'));
  var cfgBtn = $('sim-cfg'), cfgBox = $('sim-config');
  var followed = null, followNext = null, idleShown = false;   // the request followed, or the arrival count to follow the next after
  var FOLLOW_MS = 150, followedAt = -Infinity;                 // the strip is rewritten at most this often (frame time)
  var lastKey = null, cfgHtml = '';                             // the knob last changed (the config drawer highlights it)
  var sbWork = $('sb-work'), sbLog = $('sb-log'), sbCmd = $('sb-cmd'), sbConfig = $('sb-config'), sbGo = $('sb-go');
  var sbModels = $('sb-models'), sbMem = $('sb-mem'), sbMemOut = $('sb-mem-v'), sbSeqs = $('sb-seqs'), sbRate = $('sb-rate');
  var sbRateOut = $('sb-rate-v'), sbLengths = $('sb-lengths'), sbKill = $('sb-kill'), wrapSpent = $('m-spent-wrap');
  var sbChalSaid = $('sb-chal-said'), sbChal = $('sb-chal'), sbChalWhat = $('sb-chal-what'), sbChalBar = $('sb-chal-bar'), sbChalNums = $('sb-chal-nums'), sbChalBtns = $('sb-chal-btns');
  var sbRadios = [].slice.call(sbWork.querySelectorAll('[role=radio][data-sb]'));
  function copySettings(st) { return Object.assign({}, st, { models: st.models.slice() }); }
  var SANDBOX = copySettings(E.SANDBOX_DEFAULTS);   // kept while the visitor stays on the page
  var challenge = null;                             // the SLO challenge running: { failedAt, why, peak, done }
  var history = [], histAt = 0;                     // the terminal's past commands
  var note = box.querySelector('.p-title .note'), kvMem = $('sim-kvmem'), kvMemOut = $('sim-kvmem-v');
  var route = $('sim-route'), routeOut = $('sim-route-v');
  var M = {
    p50: $('m-ttft50'), p99: $('m-ttft99'), tpot: $('m-tpot'), thr: $('m-thr'), kv: $('m-kv'),
    gpus: $('m-gpus'), cost: $('m-cost'), pre: $('m-pre'), rej: $('m-503'),
    small: $('m-small'), mis: $('m-mis'), api: $('m-api'), retry: $('m-retry'), spent: $('m-spent')
  };
  var tabs = [].slice.call(box.querySelectorAll('[role=tablist] [role=tab]'));
  var panels = [].slice.call(box.querySelectorAll('[role=tabpanel]'));
  // Each panel's radio group is its own roving-tabindex group
  function group(panelId) { return [].slice.call($(panelId).querySelectorAll('[role=radiogroup] [role=radio]')); }
  var batchRadios = group('sim-tab-batching'), deployRadios = group('sim-tab-mig'), largeRadios = group('sim-tab-routing');
  var trafficRadios = group('sim-tab-traffic'), autoRadios = group('sim-tab-failure');
  var traceRadio = trafficRadios.filter(function (b) { return b.getAttribute('data-traffic') === 'trace'; })[0];
  var TRACE = null, traceAsked = false;   // tab 05's trace, once loaded
  var pickedRandom = false;               // the visitor chose random in tab 05, so the trace arriving doesn't switch it

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
      var d = V.dots[r.id];
      // tab 04: a request first seen at a model's box was scored between two frames, so its dot comes in from
      // the left as if seen at System1 (inst 0) and its hop carries it through the System1 exit down its branch
      if (!d) d = V.dots[r.id] = V.place ? { x: tx, y: ty, inst: ii } : { x: -4, y: L.top + Math.random() * (L.bot - L.top), inst: L.routing ? 0 : ii };
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
      // tab 06: a failed or starting box makes no tokens, so its particles stop at once rather than decaying
      if (!inst.api && E.instanceStatus(sim, inst).state !== 'up') { V.rate[ii] = 0; V.acc[ii] = 0; }
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
    return inst.timeSliced ? 'shared H100' : sim.instances.length > 1 ? 'H100 ' + (inst.gpu + 1) : 'H100';
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
    var st = inst.api ? null : E.instanceStatus(sim, inst);
    inst.running.forEach(function (r) { if (r.state === 'running') n += 1; });
    if (st && st.state === 'up' && !inst.fits) {   // the sandbox: a model too big for its slice never starts
      var nm = boxName(inst) + ' · ' + short;
      levels = [[nm + " · doesn't fit", []], [nm, [["doesn't fit", COL.muted]]], ["doesn't fit", []]];
    } else if (st && st.state !== 'up') {   // tab 06: a killed GPU, or its replacement starting
      var gpu = 'H100 ' + (st.gpu + 1), what = st.state === 'down' ? 'failed' : 'starting ' + Math.ceil(st.readyInMs / 1000) + 's';
      levels = [[gpu + ' · ' + what, []], [gpu, [[what, COL.muted]]], [what, []]];
    } else if (inst.model === 'system1') {
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
    var st = inst.api ? null : E.instanceStatus(sim, inst);
    if (inst.api) {
      ctx.fillStyle = COL.panel; ctx.fill(); ctx.strokeStyle = COL.muted; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    } else if (st.state !== 'up' || !inst.fits) {   // tab 06: failed (dashed red), or a replacement starting (dashed, its cold start as the bar); a model that doesn't fit, as failed
      ctx.fillStyle = COL.panel; ctx.fill(); ctx.strokeStyle = st.state === 'starting' ? COL.faint : COL.badDim;
      ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
      drawHeader(h, level, b);
      var cy = b.y + b.h - 8;
      bar(b.bx, cy, b.bw, 3, COL.track);
      if (st.state === 'starting') bar(b.bx, cy, b.bw * (1 - st.readyInMs / E.COLD_START_MS), 3, COL.faint);
      return;
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
      arrivalsLabel(narrow);
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
    drawFollowed();
    drawStream();
    drawStrip();
    renderFollow();
  }

  // ---- Following a request ----

  // The request under (x, y): a drawn row in a box, else the nearest dot within 9px; null when none
  function pick(x, y) {
    var best = null, bestD = 9, id, d, dd;
    sim.instances.forEach(function (inst, ii) {
      var b = L.boxes[ii], rows = V.rows[ii], vis = drawn(b, rows.length);
      for (var j = 0; j < vis; j++) {
        var row = rows[j];
        if (row.y !== null && x >= b.bx - 3 && x <= b.bx + b.bw + 3 && y >= row.y - 2 && y <= row.y + ROW_H + 2) best = row.r;
      }
    });
    if (best) return best;
    for (id in V.dots) {
      d = V.dots[id];
      if (d.landed) continue;
      dd = Math.abs(d.x - x) + Math.abs(d.y - y);
      if (dd < bestD) { bestD = dd; best = d.r; }
    }
    return best;
  }
  // The strip changes at once (so focus can move to a button it shows), the canvas on the next frame
  function follow(r) {
    followed = r; followNext = null;
    renderFollow(true);
    if (!raf) draw();
  }
  function unfollow() {
    followed = null; followNext = null;
    if (!sim) return;
    renderFollow(true);
    if (!raf && L) draw();
  }
  // Writes a node only when what it shows changed, so the strip doesn't churn the DOM (or a screen reader)
  function put(el, v, html) {
    if (el.__shown === v) return;
    el.__shown = v;
    if (html) el.innerHTML = v; else el.textContent = v;
  }
  // "follow the next request": the first to arrive from now on
  function catchNext() {
    if (followNext === null) return;
    var best = null;
    sim.instances.forEach(function (inst) {
      inst.queue.concat(inst.running).forEach(function (r) { if (r.id > followNext && (!best || r.id < best.id)) best = r; });
    });
    if (best) { followed = best; followNext = null; }
  }
  // Its row outlined, or while it has no row, a ring round its dot
  function drawFollowed() {
    if (!followed) return;
    var ii = followed.inst, d = V.dots[followed.id], b, rows, vis;
    ctx.strokeStyle = COL.accent; ctx.lineWidth = 1.5; ctx.setLineDash([]);
    if (ii !== null && L.boxes[ii]) {
      b = L.boxes[ii]; rows = V.rows[ii]; vis = drawn(b, rows.length);
      for (var j = 0; j < vis; j++) {
        if (rows[j].r === followed && rows[j].y !== null) { rr(b.bx - 3, rows[j].y - 2.5, b.bw + 6, ROW_H + 5, 2); ctx.stroke(); return; }
      }
    }
    if (d && !d.landed) { ctx.beginPath(); ctx.arc(d.x, d.y, DOT_R + 3, 0, 6.283); ctx.stroke(); }
  }
  // Where a request is: its box's name, as the canvas shows it
  function placeName(ii) {
    var inst = sim.instances[ii];
    return inst.api ? 'API model' : inst.model === 'system1' ? 'System1' : boxName(inst);
  }
  // The strip's last line: where the request is now, then the latest thing that happened to it
  function followNote(s) {
    var f = E.fmt, at = function (m) { return f.ms(m.t - s.t0); }, last = s.marks[s.marks.length - 1], now;
    if (s.state === 'rejected') return 'turned away with a 503 at ' + at(last) + ': no queue had room';
    now = s.state === 'queued' ? 'waiting in the queue' : s.state === 'done' ? 'done: ' + s.generated.toLocaleString('en-US') + ' tokens' :
      s.generated === 0 || (s.spans.length && s.spans[s.spans.length - 1].kind === 'prefill') ? 'in prefill' :
      'decoding: ' + s.generated.toLocaleString('en-US') + ' of ' + s.output.toLocaleString('en-US') + ' tokens';
    if (!last) return now;
    if (last.kind === 'preempted') return now + ' · preempted at ' + at(last) + ': its KV was dropped, so it queued again and redid its prefill';
    if (last.kind === 'retried') return now + ' · its GPU died at ' + at(last) + ': retried from the start on ' + placeName(s.inst);
    return now + ' · System1 scored it ' + last.score.toFixed(2) + ' at ' + at(last) + ', so it went to the ' + last.target + ' model';
  }
  function renderFollow(force) {
    catchNext();
    var on = !!followed, had = document.activeElement === flNext;
    if (on && !force && !followEl.classList.contains('idle') && V.vt - followedAt < FOLLOW_MS) return;
    followedAt = V.vt;
    followEl.classList.toggle('idle', !on);
    flStop.hidden = !on; flNext.hidden = on;
    if (on && had) flStop.focus();   // the button pressed is gone now: keep the keyboard on the strip
    if (!on) {
      var what = followNext !== null ? 'waiting for the next request…' : 'click a dot or a row on the canvas to follow one request';
      if (idleShown === what) return;   // nothing changed: leave the DOM alone
      idleShown = what;
      flWhat.className = 'idle'; put(flWhat, what); put(flNums, '');
      flRows.forEach(function (row) { put(row.children[1], '', true); put(row.children[2], '\u2013'); });
      put(flNote, 'its spans, TTFT, TPOT and total time appear here');
      return;
    }
    idleShown = false;
    var s = E.requestSummary(sim, followed), f = E.fmt, span = Math.max(1, s.end - s.t0), tags = '', k;
    var pct = function (t) { return ((t - s.t0) / span * 100).toFixed(2) + '%'; }, pre = 0, scored = null;
    for (k = 0; k < s.marks.length; k++) {
      if (s.marks[k].kind === 'preempted') pre += 1;
      if (s.marks[k].kind === 'scored') scored = s.marks[k];
    }
    if (scored) tags += ' · scored ' + scored.score.toFixed(2) + ' → ' + scored.target;
    if (pre) tags += ' · <span class="fl-warn">preempted ' + (pre === 1 ? 'once' : pre + ' times') + '</span>';
    if (followed.retries) tags += ' · <span class="fl-warn">retried</span>';
    if (s.state === 'rejected') tags += ' · <span class="fl-warn">503</span>';
    flWhat.className = '';
    put(flWhat, 'following <b>#' + s.id + '</b> · ' + s.prompt.toLocaleString('en-US') + ' → ' + s.output.toLocaleString('en-US') +
      ' tokens' + (s.inst === null ? '' : ' · ' + placeName(s.inst)) + tags, true);
    put(flNums, 'TTFT <b>' + f.ms(s.ttftMs) + '</b> · TPOT <b>' + f.ms(s.tpotMs) + '</b> · total <b>' + f.ms(s.totalMs) + '</b>', true);
    flRows.forEach(function (row) {
      var kind = row.getAttribute('data-kind'), html = '';
      s.spans.forEach(function (sp) {
        if (sp.kind === kind) html += '<span class="fl-seg" style="left:' + pct(sp.t0) + ';width:' + ((sp.t1 - sp.t0) / span * 100).toFixed(2) + '%"></span>';
      });
      s.marks.forEach(function (m) {
        if (m.kind !== 'rejected') html += '<span class="fl-mark' + (m.kind === 'scored' ? ' scored' : '') + '" style="left:' + pct(m.t) + '"></span>';
      });
      put(row.children[1], html, true);
      put(row.children[2], f.ms(s.byKind[kind]));
    });
    put(flNote, followNote(s));
  }
  cv.addEventListener('click', function (e) {
    if (!L) return;
    var r = cv.getBoundingClientRect(), p = pick(e.clientX - r.left, e.clientY - r.top);
    if (p) follow(p); else unfollow();
  });
  cv.addEventListener('mousemove', function (e) {
    if (!L) return;
    var r = cv.getBoundingClientRect();
    cv.classList.toggle('picking', !!pick(e.clientX - r.left, e.clientY - r.top));
  });
  // Paused, drained or frozen, nothing new will arrive: it follows the newest request still in flight instead
  flNext.addEventListener('click', function () {
    if (E.playState(sim, frozen) !== 'running') {
      var newest = null;
      sim.instances.forEach(function (inst) {
        inst.queue.concat(inst.running).forEach(function (r) { if (r.state !== 'idle' && (!newest || r.id > newest.id)) newest = r; });
      });
      if (newest) { follow(newest); return; }
      idleShown = false; put(flWhat, 'nothing in flight: press play or send a burst');
      return;
    }
    followed = null; followNext = sim.stats.arrived;
    renderFollow(true);
    if (!raf) draw();
    wake();
  });
  flStop.addEventListener('click', function () { unfollow(); flNext.focus(); });

  // ---- Config drawer ----

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  // Rebuilt from the engine with the footer (a kill or a replacement changes it); the DOM only when it changed
  function sandboxish() { return preset === 'sandbox' || preset === 'challenge'; }
  function renderConfig() {
    var target = sandboxish() ? sbConfig : cfgBox.hidden ? null : cfgBox;
    if (!target) return;
    var html = E.serverConfig(sim).map(function (b) {
      return '<pre class="cfg-block"><span class="c"># ' + esc(b.title) + '</span>\n' + b.lines.map(function (l) {
        var t = esc(l.text);
        if (l.comment) t = '<span class="c">' + t + '</span>';
        else t = t.replace(/^(vllm serve|router:|name:|backend:|max_batch_size:|dynamic_batching|instance_group)/, '<span class="k">$1</span>');
        return l.key && l.key === lastKey ? '<span class="hl">' + t + '</span>' : t;
      }).join('\n') + '</pre>';
    }).join('');
    if (html !== target.__html) { target.innerHTML = html; target.__html = html; }
  }
  cfgBtn.addEventListener('click', function () {
    var open = cfgBox.hidden;
    cfgBox.hidden = !open;
    cfgBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    cfgBtn.textContent = open ? 'config \u25b4' : 'config \u25be';
    cfgBox.__html = '';
    renderConfig();
  });

  // ---- Footer and play button ----

  // The canvas's aria-label in tabs 03 and 04: the view, then each model's p99 against its target, as the boxes show it
  function sloLabel() {
    var words = sim.instances.map(function (inst) {   // tab 06: which GPU is down or starting
      var st = inst.api ? null : E.instanceStatus(sim, inst);
      return !st || st.state === 'up' ? '' : '; H100 ' + (st.gpu + 1) + (st.state === 'down' ? ' failed' : ' starting');
    }).join('');
    return VIEWS[preset].aria + '. ' + V.targets.map(function (model) {
      var p = V.p99[model], slo = sim.slo[model];
      return E.MODELS[model].short + ' p99 ' + E.fmt.spoken(p) + ', target ' + E.fmt.spoken(slo) +
        (p === null ? '' : p <= slo ? ', met' : ', missed');
    }).join('; ') + words;
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
    M.rej.textContent = m.rejected.toLocaleString('en-US');
    M.rej.classList.toggle('bad', m.rejected > 0);
    // tab 04: the routing shares, and in API mode the API model's spend
    wrapSmall.hidden = wrapMis.hidden = !sim.routing;
    wrapApi.hidden = !V.api;
    if (sim.routing) { M.small.textContent = f.pct(m.smallShare); M.mis.textContent = f.pct(m.misroutedShare); }
    // tab 06: the retries, and the kill button while there's a second GPU up to kill
    wrapRetry.hidden = preset !== 'failure' && !sandboxish();
    wrapSpent.hidden = !sandboxish();
    if (sandboxish()) M.spent.textContent = usd(E.spentUsd(sim) - V.spent0);
    if (challenge && preset === 'challenge') judge();
    M.retry.textContent = sim.stats.retried.toLocaleString('en-US');
    // aria-disabled, not disabled: disabling the focused button would drop keyboard focus to the page
    if (preset === 'failure' && sim.instances.filter(function (inst) { return !inst.api && E.instanceStatus(sim, inst).state === 'up'; }).length < 2) {
      killBtn.setAttribute('aria-disabled', 'true'); killBtn.title = 'one GPU left';
    } else { killBtn.removeAttribute('aria-disabled'); killBtn.removeAttribute('title'); }
    renderConfig();
    V.spend = m.apiUsdPerHour;   // and the API box's header
    if (V.api) M.api.textContent = perHour(V.spend);
    return m;
  }
  function sample(m) {
    V.hist.push({ t: sim.t, v: m.ttftP99 });
    if (V.hist.length > SAMPLES) V.hist.shift();
  }

  // The SLO challenge replays a fixed window: it may be started from a frozen start, but not paused, and bursts
  // aren't sent, or the workload it scores would change. True when the click is refused.
  function holdWorkload() {
    if (preset !== 'challenge' || frozen || E.playState(sim, frozen) === 'stopped') return false;
    log('not during the challenge: it runs its window to the end (stop the challenge to pause)', 'err');
    return true;
  }
  function renderPlay() {
    var st = E.playState(sim, frozen);
    burstBtn.setAttribute('aria-disabled', preset === 'challenge' ? 'true' : 'false');
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
  // Every tab's lesson line gets the tallest one's height, so the canvas sits at the same place on every tab.
  // They wrap differently at every width (and with the web font in), so this measures them rather than guessing.
  function evenLessons() {
    var panels = [].slice.call(box.querySelectorAll('.sim-lesson')), hidden = panels.map(function (p) { return p.hidden; }), tallest = 0;
    panels.forEach(function (p) { p.hidden = false; p.style.minHeight = '0px'; });
    panels.forEach(function (p) { tallest = Math.max(tallest, p.getBoundingClientRect().height); });
    panels.forEach(function (p, i) { p.hidden = hidden[i]; p.style.minHeight = Math.ceil(tallest) + 'px'; });
  }

  function resize() {
    evenLessons();
    if (!measure() || !sim) return;
    layout(); V.place = true; sync(0); draw();
  }

  // ---- Tabs and controls ----

  // Checks the radio that matches, and makes it the one Tab stops on in its group
  // The arrivals column's label: on tab 05's trace, where the replay is in its hour, else "requests →"
  function arrivalsLabel(narrow) {
    var c = E.traceClock(sim), s;
    if (c) {
      s = narrow ? mmss(c.ms) : 'trace ' + mmss(c.ms) + ' / ' + mmss(c.totalMs);
      if (10 + ctx.measureText(s).width + 6 > L.qx0 - 4) s = mmss(c.ms);
    } else s = 10 + ctx.measureText('requests →').width + 6 > L.qx0 - 4 ? 'requests' : 'requests →';
    text(s, 10, 16, 10, COL.faint);
  }
  function mmss(ms) { var s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2); }

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
    check(trafficRadios, 'data-traffic', preset.indexOf('traffic-') === 0 ? preset.slice(8) : 'trace');
    check(autoRadios, 'data-autoscale', sim.autoscaler ? 'on' : 'off');
  }

  // Tab 05's trace loads when the panel first comes into view, or when tab 05 opens before that. Until it's in,
  // the trace option is disabled and says why, and tab 05 runs on random traffic; when it arrives, tab 05
  // switches to it unless the visitor picked random. A failed load is tried again the next time tab 05 opens.
  function traceState(title) {
    if (title) { traceRadio.setAttribute('aria-disabled', 'true'); traceRadio.title = title; }
    else { traceRadio.removeAttribute('aria-disabled'); traceRadio.removeAttribute('title'); }
  }
  function loadTrace() {
    if (traceAsked) return;
    traceAsked = true;
    fetch('assets/sim/azure-conv.json').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      TRACE = d;
      traceState(null);
      syncKnobs();
      if (preset === 'traffic-random' && !pickedRandom) deploy('traffic-trace');
    }).catch(function () {
      traceAsked = false;
      traceState('the trace didn\'t load');
    });
  }

  // A redeploy: builds the preset with a fresh seed and warms it up, so it opens mid-flow (tabs 03 and 04,
  // whose boxes show a 30 s p99, for longer). Tab 04 starts at the slider's threshold, so a mode switch keeps
  // it, from the warm-up on and with no marker. Nothing of the old sim's view carries over, and frozen stays
  // as it is (reduced motion opens every one frozen).
  function deploy(id, config) {
    if (id === 'sandbox' || id === 'challenge') sandboxViews();
    var p = id === 'traffic-trace' ? E.tracePreset(TRACE) : id === 'sandbox' ? E.sandboxPreset(SANDBOX, TRACE) :
      id === 'challenge' ? E.challengePreset(SANDBOX, TRACE) : E.PRESETS[id];
    preset = id;
    sim = E.createSim(Object.assign({}, p, {
      seed: Math.floor(Math.random() * 2147483647), config: config || p.config,
      routing: p.routing ? Object.assign({}, p.routing, { threshold: +route.value }) : null
    }));
    V = freshView();
    // the challenge starts from empty servers, at minute 20 of the hour
    for (var k = 0, n = id === 'challenge' ? 0 : sim.slo ? TAB03_WARMUP_TICKS : WARMUP_TICKS; k < n; k++) {
      E.tick(sim, TICK_MS);
      if (sim.t >= V.nextSample) { V.nextSample += SAMPLE_MS; sample(E.metrics(sim)); }
    }
    V.spent0 = E.spentUsd(sim);   // the cost meter counts from the open, not the warm-up
    V.rejected = sim.stats.rejected;
    note.textContent = VIEWS[id].note;
    cv.setAttribute('aria-label', VIEWS[id].aria);
    // blended in API mode: the H100 plus the API model's tokens
    M.cost.parentNode.title = 'per 1M output tokens · H100 at $' + E.GPU_HOUR_USD.toFixed(2) + '/h · ' + E.GPU_HOUR_SOURCE +
      (V.api ? ' · plus the API model at $' + E.API.inputPer1M.toFixed(2) + ' / $' + E.API.outputPer1M.toFixed(2) +
               ' per 1M input / output tokens · ' + E.API_SOURCE : '');
    syncRadios();
    shown = null;
    measure();
    L = null;
    unfollow();   // a new sim: nothing of the old one stays followed
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
    showRoute();
    pickedRandom = false;
    lastKey = null;
    stopChallenge(false);
    var sb = id === 'sandbox';
    sbWork.hidden = !sb; sbChal.hidden = true; cfgBtn.hidden = sb;
    if (sb) { cfgBox.hidden = true; cfgBtn.setAttribute('aria-expanded', 'false'); cfgBtn.textContent = 'config \u25be'; }
    if (id === 'kvcache') deploy('kvcache', { gpuMemUtil: KV_MEM });
    else if (id === 'traffic') { loadTrace(); deploy(TRACE ? 'traffic-trace' : 'traffic-random'); }
    else if (id === 'failure') deploy('failure');
    else if (id === 'sandbox') { loadTrace(); deploy('sandbox'); }
    else deploy(id === 'mig' ? 'mig-mig' : id === 'routing' ? 'routing-onprem' : 'batching');
  }

  function setMode(b) {
    E.setBatching(sim, b.getAttribute('data-batching'));
    lastKey = 'batching';
    renderConfig();
    syncRadios();
    if (!raf) draw();   // frozen or stopped: show the new marker now
  }
  function setDeploy(b) {
    var id = 'mig-' + b.getAttribute('data-deploy');
    if (id !== preset) { lastKey = null; deploy(id); }
  }
  function setLarge(b) {
    var id = 'routing-' + b.getAttribute('data-large');
    if (id !== preset) { lastKey = 'large'; deploy(id); }   // at the slider's threshold
  }
  // Tab 06: the autoscaler switches live, and a kill acts on the running sim; neither redeploys
  function setAuto(b) {
    E.setAutoscaler(sim, b.getAttribute('data-autoscale') === 'on');
    lastKey = 'autoscaler';
    syncRadios();
    footer();
    if (!raf) draw();   // frozen or stopped: show it now
    wake();
  }
  function kill() {
    if (E.killGpu(sim) === null) return;
    footer();
    if (!raf) draw();
    wake();
  }
  function setTraffic(b) {
    var id = 'traffic-' + b.getAttribute('data-traffic');
    if (b.getAttribute('aria-disabled') === 'true') return;
    pickedRandom = id === 'traffic-random';
    if (id !== preset) deploy(id);
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
  trafficRadios.forEach(function (b) { b.addEventListener('click', function () { setTraffic(b); }); });
  arrows(trafficRadios, RADIO_KEYS, setTraffic);
  autoRadios.forEach(function (b) { b.addEventListener('click', function () { setAuto(b); }); });
  arrows(autoRadios, RADIO_KEYS, setAuto);
  killBtn.addEventListener('click', kill);
  // The output follows the slider as it moves; a redeploy waits for the change (release, or a key step),
  // since --gpu-memory-utilization is a startup flag
  kvMem.addEventListener('input', function () { kvMemOut.textContent = (+kvMem.value).toFixed(2); });
  kvMem.addEventListener('change', function () {
    kvMemOut.textContent = (+kvMem.value).toFixed(2);
    lastKey = 'gpu-memory-utilization';
    deploy('kvcache', { gpuMemUtil: +kvMem.value });
  });
  // Tab 04's threshold is a router setting, so it moves live on the change: requests scored from then
  // on use it, and the sparkline marks it
  // At 1 nothing goes to the large model (no score is above 1), so the readout says so rather than "≥ 1.00"
  function showRoute() {
    var x = +route.value, none = x >= 1;
    routeOut.textContent = x.toFixed(2) + (none ? ' (none)' : '');
    route.setAttribute('aria-valuetext', none ? '1.00, nothing goes to the large model' : x.toFixed(2));
  }
  route.addEventListener('input', showRoute);
  route.addEventListener('change', function () {
    showRoute();
    E.setThreshold(sim, +route.value);
    lastKey = 'threshold';
    renderConfig();
    if (!raf) draw();   // frozen or stopped: show the new marker now
  });

  // ---- Sandbox ----

  function usd(v) { return '$' + (v < 1 ? v.toFixed(4) : v.toFixed(2)); }
  function clock(ms) { var t = Math.max(0, Math.round(ms / 1000)); return Math.floor(t / 60) + ':' + ('0' + t % 60).slice(-2); }
  function describe(st) {
    return st.gpus + ' × H100' + (st.layout === 'whole' ? '' : st.layout === 'time-sliced' ? ', time-sliced' : ', MIG ' + st.layout);
  }
  function sandboxViews() {
    var d = describe(SANDBOX);
    VIEWS.sandbox = { note: '· sandbox: ' + d + ' · real time', label: d, narrow: SANDBOX.gpus + ' × H100',
                      aria: 'Animated simulation: your sandbox deployment, ' + d };
    VIEWS.challenge = { note: '· SLO challenge: ' + d + ' · Azure peak, 12× faster', label: d, narrow: SANDBOX.gpus + ' × H100',
                        aria: 'Animated simulation: the SLO challenge, the peak of the Azure hour replayed against ' + d };
  }
  function log(text, cls) {
    var line = document.createElement('div');
    line.className = cls || '';
    line.textContent = text;
    sbLog.appendChild(line);
    while (sbLog.childNodes.length > 80) sbLog.removeChild(sbLog.firstChild);
    sbLog.scrollTop = sbLog.scrollHeight;
  }
  function statusLine() {
    var m = E.metrics(sim), f = E.fmt;
    return 'TTFT p99 ' + f.ms(m.ttftP99) + ' · throughput ' + f.tok(m.tokPerSec) + ' · KV ' + f.pct(m.kvFrac) + ' · GPUs ' + sim.gpuCount +
      ' · 503s ' + m.rejected + ' · spent ' + usd(E.spentUsd(sim) - V.spent0);
  }
  // One command, typed or from a knob (both show in the terminal, so the knobs teach its commands)
  function run(line) {
    var r = E.sandboxCommand(SANDBOX, line), a = r.action, msg = r.message, k;
    if (r.ok && !a) return;
    log('› ' + line, 'cmd');
    if (!r.ok) { log(r.message, 'err'); return; }
    if (preset === 'challenge' && (a === 'pause' || a === 'burst' || (a === 'play' && !frozen))) {
      log('not during the challenge: it replays a fixed window of traffic', 'err');
      return;
    }
    SANDBOX = r.settings;
    if ((a === 'deploy' || a === 'reset') && preset === 'challenge') log('challenge stopped: the deployment changed', 'hint');
    if (a === 'deploy' || a === 'reset') {
      if (a === 'reset') { SANDBOX = copySettings(E.SANDBOX_DEFAULTS); msg = 'back to the defaults: ' + describe(SANDBOX); }
      lastKey = /gpu-mem/.test(line) ? 'gpu-memory-utilization' : /max-num-seqs/.test(line) ? 'max-num-seqs' : null;
      stopChallenge(false);
      deploy('sandbox');
      sim.instances.forEach(function (inst) {
        if (!inst.api && !inst.fits) msg += ' · ' + E.MODELS[inst.model].label + " doesn't fit " + inst.profile + ': its requests get 503s';
      });
    } else if (a === 'batching') { E.setBatching(sim, SANDBOX.batching); lastKey = 'batching'; }
    else if (a === 'router') { E.setRouter(sim, SANDBOX.router); lastKey = 'router'; }
    else if (a === 'autoscaler') { E.setAutoscaler(sim, SANDBOX.autoscaler); lastKey = 'autoscaler'; }
    else if (a === 'kill') {
      k = E.killGpu(sim);
      if (k === null) { log('only one GPU is up: nothing to kill', 'err'); return; }
      msg = 'killed H100 ' + (k + 1) + ': its requests retry on the others';
    } else if (a === 'burst') {
      if (frozen) { frozen = false; E.setArrivals(sim, false); }
      E.sendBurst(sim, r.value, 0);
    } else if (a === 'pause') { if (E.playState(sim, frozen) === 'running') E.setArrivals(sim, false); msg = 'paused: what is in flight finishes'; }
    else if (a === 'play') { frozen = false; E.setArrivals(sim, true); msg = 'playing'; }
    else if (a === 'challenge') { startChallenge(); return; }
    else if (a === 'status') msg = statusLine();
    else if (a === 'clear') { sbLog.textContent = ''; return; }
    log(a === 'help' || a === 'status' ? msg : 'ok  ' + msg, a === 'help' || a === 'status' ? 'hint' : 'ok');
    syncKnobs(); renderConfig(); footer(); renderPlay();
    if (!raf) draw();
    wake();
  }
  // The knobs show SANDBOX; a choice that would put more servers on the canvas than it can draw is disabled
  function syncKnobs() {
    var slots = E.SANDBOX_LAYOUTS[SANDBOX.layout].length, max = E.SANDBOX_MAX_SERVERS;
    sbRadios.forEach(function (b) {
      var key = b.getAttribute('data-sb'), v = b.getAttribute('data-v'), cur = SANDBOX[key], off = false;
      if (key === 'bursts' || key === 'autoscaler') cur = cur ? 'on' : 'off';
      var on = String(cur) === v;
      if (key === 'gpus') off = +v * slots > max;
      if (key === 'layout') off = SANDBOX.gpus * E.SANDBOX_LAYOUTS[v].length > max;
      if (key === 'traffic' && v === 'trace') off = !TRACE;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (off) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
    });
    if (sbModels.children.length !== slots || sbModels.__layout !== SANDBOX.layout) {
      sbModels.__layout = SANDBOX.layout;
      sbModels.innerHTML = E.SANDBOX_LAYOUTS[SANDBOX.layout].map(function (profile, k) {
        return '<select aria-label="Model on slice ' + (k + 1) + ' (' + profile + ')">' +
          [['llama-3-8b', '8B'], ['llama-3.2-3b', '3B'], ['llama-3.2-1b', '1B']].map(function (o) {
            return '<option value="' + o[0] + '">' + (profile === '7g.80gb' ? '' : profile.split('.')[0] + ' · ') + o[1] + '</option>';
          }).join('') + '</select>';
      }).join('');
    }
    [].slice.call(sbModels.children).forEach(function (sel, k) { sel.value = SANDBOX.models[Math.min(k, SANDBOX.models.length - 1)]; });
    sbMem.value = String(SANDBOX.gpuMemUtil); sbMemOut.textContent = SANDBOX.gpuMemUtil.toFixed(2);
    sbSeqs.value = String(SANDBOX.maxNumSeqs);
    sbRate.value = String(SANDBOX.rate); sbRateOut.textContent = SANDBOX.rate + '/s'; sbRate.disabled = SANDBOX.traffic === 'trace';
    sbLengths.value = SANDBOX.lengths;
  }
  var WORD = { 'llama-3-8b': '8b', 'llama-3.2-3b': '3b', 'llama-3.2-1b': '1b' };
  function knob(b) {
    if (b.getAttribute('aria-disabled') === 'true' || b.getAttribute('aria-checked') === 'true') return;
    var key = b.getAttribute('data-sb'), v = b.getAttribute('data-v');
    run(key === 'gpus' || key === 'layout' || key === 'batching' || key === 'traffic' || key === 'bursts' || key === 'router' || key === 'autoscaler' ? key + ' ' + v : '');
  }
  [].slice.call(sbWork.querySelectorAll('[role=radiogroup]')).forEach(function (g) {
    var list = [].slice.call(g.querySelectorAll('[role=radio]'));
    list.forEach(function (b) { b.addEventListener('click', function () { knob(b); }); });
    arrows(list, RADIO_KEYS, knob);
  });
  sbModels.addEventListener('change', function () {
    run('models ' + [].slice.call(sbModels.children).map(function (sel) { return WORD[sel.value]; }).join(' '));
  });
  sbMem.addEventListener('input', function () { sbMemOut.textContent = (+sbMem.value).toFixed(2); });
  sbMem.addEventListener('change', function () { run('set gpu-mem ' + (+sbMem.value).toFixed(2)); });
  sbSeqs.addEventListener('change', function () { run('set max-num-seqs ' + sbSeqs.value); });
  sbRate.addEventListener('input', function () { sbRateOut.textContent = sbRate.value + '/s'; });
  sbRate.addEventListener('change', function () { run('rate ' + sbRate.value); });
  sbLengths.addEventListener('change', function () { run('lengths ' + sbLengths.value); });
  sbKill.addEventListener('click', function () { run('kill'); });
  sbCmd.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var line = sbCmd.value.trim();
      sbCmd.value = '';
      if (line) { history.push(line); histAt = history.length; }
      run(line);
    } else if (e.key === 'ArrowUp' && histAt > 0) { e.preventDefault(); sbCmd.value = history[--histAt]; }
    else if (e.key === 'ArrowDown' && histAt < history.length) { e.preventDefault(); histAt += 1; sbCmd.value = history[histAt] || ''; }
  });

  // The SLO challenge: the peak of the Azure hour, once, against SANDBOX. It fails on a 30 s p99 over the
  // target or on any 503, and ends once its last request is served.
  var CHALLENGE_MS = (E.CHALLENGE.endMs - E.CHALLENGE.startMs) / 12;   // the window at 12x, about 75 s
  function startChallenge() {
    if (!TRACE) { log('the Azure trace is still loading: try again in a moment', 'err'); return; }
    try { E.challengePreset(SANDBOX, TRACE); } catch (err) { log(err.message, 'err'); return; }
    log('› challenge: Azure\'s peak against ' + describe(SANDBOX) + ' · p99 ≤ 2 s, no 503s', 'cmd');
    challenge = { failedAt: null, why: '', peak: 0, result: null };
    sbChalSaid.textContent = '';
    lastKey = null;
    deploy('challenge');
    sbChal.hidden = false; sbChalBtns.hidden = true; sbGo.textContent = 'stop the challenge';
    judge();
  }
  function stopChallenge(redeploy) {
    if (!challenge && preset !== 'challenge') return;
    challenge = null;
    sbChal.hidden = true; sbGo.textContent = 'take the SLO challenge \u203a';
    if (redeploy) deploy('sandbox');
  }
  function judge() {
    var f = E.fmt, p = E.metrics(sim, 'llama-3-8b', E.CHALLENGE.windowMs).ttftP99, rej = sim.stats.rejected, slo = E.CHALLENGE.sloMs;
    var cost = sim.stats.outputTokens ? E.spentUsd(sim) / sim.stats.outputTokens * 1e6 : null;
    if (challenge.result) return;   // done: nothing after the window changes the verdict
    if (p !== null) challenge.peak = Math.max(challenge.peak, p);
    if (challenge.failedAt === null && ((p !== null && p > slo) || rej > 0)) {
      challenge.failedAt = sim.t;
      challenge.why = p !== null && p > slo ? 'p99 ' + f.ms(p) + ' over the 2 s target' : rej + ' requests turned away (503)';
    }
    var perM = function (v) { return v === null ? '\u2013' : f.usd(v); }, par = 'par ' + perM(E.CHALLENGE.parUsdPer1M) + ' (2 × H100)';
    if (!challenge.result && E.challengeDone(sim)) {
      // the verdict and the cost are final once the window's last request is served
      challenge.result = {
        what: challenge.failedAt === null ? '<b class="ok">Passed.</b> ' + describe(SANDBOX) + ': p99 peaked at ' + f.ms(challenge.peak) + ', no 503s' :
          '<b class="bad">Failed at ' + clock(challenge.failedAt) + '.</b> ' + challenge.why,
        nums: 'you: <b>' + perM(cost) + '</b> · ' + par,
        said: (challenge.failedAt === null ? 'Challenge passed at ' : 'Challenge failed at ' + clock(challenge.failedAt) + ', ') + perM(cost)
      };
      sbChalWhat.innerHTML = challenge.result.what;
      sbChalNums.innerHTML = challenge.result.nums;
      sbChalSaid.textContent = challenge.result.said;
      sbChalBar.style.width = '100%';
      sbChalBtns.hidden = false;
    }
    if (challenge.result) return;
    sbChalWhat.innerHTML = '<b>SLO challenge</b> · the Azure hour\'s peak (minutes 20–35, 12× faster) · TTFT p99 ≤ 2 s, no 503s';
    sbChalBar.style.width = Math.min(100, sim.t / CHALLENGE_MS * 100).toFixed(1) + '%';
    sbChalNums.innerHTML = (challenge.failedAt !== null ? '<b class="bad">failed at ' + clock(challenge.failedAt) + '</b> · ' : '') +
      clock(CHALLENGE_MS - sim.t) + ' left · p99 <b class="' + (p !== null && p > slo ? 'bad' : 'ok') + '">' + f.ms(p) + '</b> · 503s <b>' + rej +
      '</b> · <b>' + perM(cost) + '</b>';
  }
  sbGo.addEventListener('click', function () { if (preset === 'challenge') stopChallenge(true); else startChallenge(); });
  // both hide themselves: the keyboard goes back to the challenge button
  $('sb-again').addEventListener('click', function () { startChallenge(); sbGo.focus(); });
  $('sb-free').addEventListener('click', function () { stopChallenge(true); sbGo.focus(); });
  log('sandbox · type help for the commands, or use the knobs', 'hint');
  syncKnobs();

  // Pause stops new arrivals and lets in-flight work drain; play (also from draining) restarts them
  playBtn.addEventListener('click', function () {
    if (holdWorkload()) return;
    if (E.playState(sim, frozen) === 'running') E.setArrivals(sim, false);
    else { frozen = false; E.setArrivals(sim, true); }
    renderPlay();
    wake();
  });
  // A burst while stopped plays just that burst. A frozen start (reduced motion) still has arrivals
  // on from the warm-up, so they go off first: the button read "▶ play" and must keep meaning stopped.
  burstBtn.addEventListener('click', function () {
    if (preset === 'challenge') { log('not during the challenge: it replays a fixed window of traffic', 'err'); return; }
    if (frozen) { frozen = false; E.setArrivals(sim, false); }
    E.sendBurst(sim, BURST, 0);   // stream 0: tab 03's 8B, and in tab 04 the System1 model, so it's routed
    renderPlay();
    wake();
  });

  // Each lesson's "?" opens its full text (a popover, so the browser handles Esc, outside clicks and focus);
  // placed under the "?" in page coordinates, so it scrolls with the page, and kept inside the viewport's width
  [].slice.call(box.querySelectorAll('.sim-pop')).forEach(function (pop) {
    var btn = box.querySelector('.sim-more[popovertarget="' + pop.id + '"]');
    pop.addEventListener('toggle', function (e) {
      var open = e.newState === 'open';
      btn.classList.toggle('open', open);
      if (!open) return;
      var r = btn.getBoundingClientRect(), w = pop.offsetWidth;
      pop.style.top = (r.bottom + window.scrollY + 8) + 'px';
      pop.style.left = (window.scrollX + Math.max(16, Math.min(r.left - 24, document.documentElement.clientWidth - w - 16))) + 'px';
    });
  });

  traceState('loading the trace…');
  resize();
  switchTab('batching');
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(evenLessons);
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(cv);
  else window.addEventListener('resize', resize);
  if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; if (visible) loadTrace(); wake(); }).observe(cv);
  else { visible = true; loadTrace(); wake(); }
  document.addEventListener('visibilitychange', wake);
})();
