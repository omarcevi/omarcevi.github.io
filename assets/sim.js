// Inference simulator, page side: draws the engine in assets/sim-engine.js (window.SimEngine)
// on the #sim canvas and wires the panel's controls. Each tab is an engine preset, rebuilt and
// warmed up when the tab opens; tab 02's memory slider and tab 03's deployment switch redeploy the
// same way. The canvas shows arrivals, each instance's queue lane, its running sequences (one row
// each, flashing amber when preempted) and KV cache, the token stream, and a rolling TTFT p99 line
// with a marker for each switch the visitor makes. In tab 03 each box also shows its model's p99 next
// to that model's SLO (green or red, and in words in the canvas's aria-label), and a time-sliced step's
// stretch. Animations run on the page's frame clock; the sim's own clock stops once it has drained.
(function () {
  'use strict';
  var E = window.SimEngine;
  var box = document.getElementById('simbox'), cv = document.getElementById('sim');
  if (!E || !box || !cv || !cv.getContext) return;
  var ctx = cv.getContext('2d');
  var REDUCE = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function $(id) { return document.getElementById(id); }

  var WARMUP_TICKS = 500, TICK_MS = 16;  // 8 s of sim time, so a tab never opens empty
  var TAB03_WARMUP_TICKS = 2500;         // 40 s in tab 03, so a deployment opens on steady state with a full 30 s p99 window
  var SAMPLE_MS = 300, SAMPLES = 110;    // footer refresh and sparkline samples, in sim time
  var FLASH_MS = 300;                    // a finished row flashes green this long, a preempted one amber
  var P99_WINDOW_MS = 30000;             // a box's p99 vs its SLO: its model's first tokens of the last 30 s (at most the latest 200), the footer's window
  var TALL_AT = 3;                       // instances: from three, the canvas grows (#sim.tall) so each box draws 6 rows (5 on phones)
  var BURST = 24;
  var ROW_H = 4, ROW_GAP = 2.2, CELL = 9.5, DOT_R = 3.2, STRIP_H = 26;
  var FADE_NEAR = 18, FADE_SPAN = 40;    // a dot for a row under "+N more" is gone this close to its target (px)
  var TOKENS_PER_PARTICLE = 100, MAX_PARTICLES_PER_S = 30;
  var FONT = '"Geist Mono", ui-monospace, monospace';
  var COL = {
    faint: '#5c626d', muted: '#8b919c', accent: '#7aa2ff', ok: '#4ade80', warn: '#f5a524', bad: '#ef4444',
    panel: '#0f1115', box: '#161920', line: '#2a2f38', track: '#232830', sep: '#1c2027',
    prefillTodo: 'rgba(122,162,255,0.22)', decode: 'rgba(122,162,255,0.6)', idle: 'rgba(139,145,156,0.35)',
    doneDecode: 'rgba(74,222,128,0.55)', preDecode: 'rgba(245,165,36,0.55)', free: 'rgba(122,162,255,0.55)',
    lane: 'rgba(220,225,235,0.12)', grid: 'rgba(220,225,235,0.06)'
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
    }
  };
  var KV_MEM = 0.9;   // tab 02's slider default, vLLM's --gpu-memory-utilization default

  var playBtn = $('sim-play'), burstBtn = $('sim-burst'), wrap503 = $('m-503-wrap'), wrapPre = $('m-pre-wrap');
  var note = box.querySelector('.p-title .note'), kvMem = $('sim-kvmem'), kvMemOut = $('sim-kvmem-v');
  var M = {
    p50: $('m-ttft50'), p99: $('m-ttft99'), tpot: $('m-tpot'), thr: $('m-thr'), kv: $('m-kv'),
    gpus: $('m-gpus'), cost: $('m-cost'), pre: $('m-pre'), rej: $('m-503')
  };
  var tabs = [].slice.call(box.querySelectorAll('[role=tablist] [role=tab]'));
  var panels = [].slice.call(box.querySelectorAll('[role=tabpanel]'));
  // Each panel's radio group is its own roving-tabindex group
  function group(panelId) { return [].slice.call($(panelId).querySelectorAll('[role=radiogroup] [role=radio]')); }
  var batchRadios = group('sim-tab-batching'), deployRadios = group('sim-tab-mig');
  M.cost.parentNode.title = 'per 1M output tokens · H100 at $' + E.GPU_HOUR_USD.toFixed(2) + '/h · ' + E.GPU_HOUR_SOURCE;

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
  // GPU 0.49-0.84, token stream 0.84-1, and the sparkline strip along the bottom
  function layout() {
    var n = sim.instances.length, gap = 8, top = 26, bot = H - STRIP_H - 8, h = (bot - top - gap * (n - 1)) / n;
    L = { top: top, bot: bot, qx0: Math.round(W * 0.19), qx1: Math.round(W * 0.44), gx0: Math.round(W * 0.49), gx1: Math.round(W * 0.84), by: H - STRIP_H, boxes: [] };
    for (var k = 0; k < n; k++) {
      var b = { x: L.gx0, y: top + k * (h + gap), w: L.gx1 - L.gx0, h: h };
      b.bx = b.x + 8; b.bw = b.w - 16; b.rowTop = b.y + 18;
      b.cap = Math.max(1, Math.floor((b.y + h - 14 - b.rowTop + ROW_GAP) / (ROW_H + ROW_GAP)));   // rows that fit
      b.qrows = Math.max(1, Math.floor((h - 8) / CELL));
      b.qcols = Math.max(1, Math.floor((L.qx1 - L.qx0) / CELL));
      L.boxes.push(b);
    }
  }
  // Rows drawn out of n: all of them while they fit, else all but the last two lines, which hold "+N more"
  function drawn(b, n) { return n > b.cap ? Math.max(0, b.cap - 2) : n; }
  function lineY(b, j) { return b.rowTop + j * (ROW_H + ROW_GAP); }
  // Row j's top out of n rows; the rows under "+N more" wait behind the last drawn one
  function rowY(b, j, n) { return lineY(b, Math.max(0, Math.min(j, drawn(b, n) - 1))); }
  // Queue slot i of an instance's lane, oldest first, filling columns top to bottom
  function qslot(b, i) {
    var col = Math.min(Math.floor(i / b.qrows), b.qcols - 1), row = i % b.qrows;
    return [L.qx0 + col * CELL + CELL / 2, b.y + 4 + row * CELL + CELL / 2];
  }
  function prefillW(b, r) { return Math.max(3, b.bw * 0.25 * Math.min(1, r.prefillTarget / 4000)); }
  function decodeW(b, pw, tokens) { return Math.min(b.bw - pw - 1.5, b.bw * Math.min(1, tokens / 1000)); }

  // ---- View state: what the canvas shows, eased towards the engine's state ----

  function freshView() {
    var zeros = sim.instances.map(function () { return 0; }), models = {};
    sim.instances.forEach(function (inst) { models[inst.model] = true; });
    return {
      vt: 0,              // frame clock (ms); it runs on after the sim's clock stops
      place: true,        // the next sync puts everything at its target instead of easing there
      dots: {},           // request id -> a dot for a queued request, or one flying to its row
      rows: sim.instances.map(function () { return []; }),   // per instance: { r, y, gen, doneAt, flew, pre, preAt }
      rate: zeros.slice(), acc: zeros.slice(),               // per instance: tok/s (smoothed), particle debt
      fly: [], toks: [], rejects: [],                        // finished requests, token particles, 503s
      hist: [], nextSample: SAMPLE_MS, rejected: 0,
      multi: Object.keys(models).length > 1,                 // several models: each box names its model
      p99: {}                                                // model -> TTFT p99 over P99_WINDOW_MS (tab 03), per footer refresh
    };
  }

  function flyOut(b, row) {
    if (V.fly.length > 60) return;
    var pw = prefillW(b, row.r);
    V.fly.push({ x: b.bx + pw + 1.5 + decodeW(b, pw, row.r.generated), y: row.y + ROW_H / 2, vx: 170 + Math.random() * 90 });
  }
  function tokenOut(b, rows) {
    if (V.toks.length > 120) return;
    var vis = drawn(b, rows.length);   // from a drawn row, not from under "+N more"
    var y = vis ? rows[Math.floor(Math.random() * vis)].y + ROW_H / 2 : b.y + b.h / 2;
    V.toks.push({ x: b.x + b.w + 2, y: y, vx: 110 + Math.random() * 80 });
  }

  function sync(dt) {
    var k = V.place ? 1 : Math.min(1, dt / 1000 * 9), seen = {};
    function dot(r, tx, ty, lands, fade) {
      var d = V.dots[r.id];
      if (!d) d = V.dots[r.id] = V.place ? { x: tx, y: ty } : { x: -4, y: L.top + Math.random() * (L.bot - L.top) };
      d.x += (tx - d.x) * k; d.y += (ty - d.y) * k;
      if (!lands) d.landed = false;
      else if (d.landed || Math.abs(tx - d.x) + Math.abs(ty - d.y) < 3) { d.landed = true; d.x = tx; d.y = ty; }
      d.r = r; d.tx = tx; d.ty = ty; d.fade = !!fade;
      seen[r.id] = true;
    }
    sim.instances.forEach(function (inst, ii) {
      var b = L.boxes[ii], rows = V.rows[ii], live = {}, have = {}, made = 0, j, row, r, ty;
      var vis = drawn(b, rows.length);   // rows drawn; the rest are "+N more"
      inst.running.forEach(function (x) { live[x.id] = x; });
      for (j = rows.length - 1; j >= 0; j--) {
        row = rows[j]; r = row.r;
        made += r.generated - row.gen; row.gen = r.generated;
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
        if (live[row.r.id] === row.r || row.preAt !== null) dot(row.r, b.bx + 2, ty + ROW_H / 2, true, j >= vis);
      }
      inst.queue.forEach(function (x, qi) { if (!seen[x.id]) { var p = qslot(b, qi); dot(x, p[0], p[1], false); } });
      if (dt > 0) {   // token particles: scaled to the instance's tok/s, at most 30 a second
        V.rate[ii] += (made * 1000 / dt - V.rate[ii]) * Math.min(1, dt / 600);
        V.acc[ii] += Math.min(MAX_PARTICLES_PER_S, V.rate[ii] / TOKENS_PER_PARTICLE) * dt / 1000;
        for (; V.acc[ii] >= 1; V.acc[ii] -= 1) tokenOut(b, rows);
      }
    });
    for (var id in V.dots) if (!seen[id]) delete V.dots[id];

    var turnedAway = sim.stats.rejected - V.rejected, b0 = L.boxes[0];   // 503s: the router had nowhere to send them
    V.rejected = sim.stats.rejected;
    for (var q = 0; !V.place && q < Math.min(turnedAway, 8); q++) {
      V.rejects.push({ x: -4, y: L.top + Math.random() * (L.bot - L.top), ty: b0.y + 6 + Math.random() * (b0.h - 12), age: 0 });
    }
    var s = dt / 1000;
    V.fly = V.fly.filter(function (p) { p.x += p.vx * s; return p.x < W + 30; });
    V.toks = V.toks.filter(function (p) { p.x += p.vx * s; return p.x < W + 6; });
    V.rejects = V.rejects.filter(function (p) {
      p.age += dt; p.x += (L.qx0 - 12 - p.x) * k; p.y += (p.ty - p.y) * k;
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
  // tab 03 the model's p99 against its SLO ("p99 1.84s / 2s", the p99 green or red), else the running
  // count, then KV. levels runs from the fullest header to the barest: pieces drop from the right (KV,
  // then "p99 " and the spaces around the slash), and last the name gives way to just the model. A
  // time-sliced box always keeps room for its marker, so nothing shifts as it blinks.
  function header(inst) {
    var kv = inst.kvBudget > 0 ? inst.kvUsed / inst.kvBudget : 0, hot = kv > 0.8, n = 0, fits;
    var kvTxt = 'KV ' + Math.round(kv * 100) + '%', kvCol = hot ? COL.warn : COL.muted;
    inst.running.forEach(function (r) { if (r.state === 'running') n += 1; });
    if (sim.slo) {
      var p = V.p99[inst.model], v = E.fmt.ms(p === undefined ? null : p), slo = E.fmt.slo(sim.slo[inst.model]);
      var pCol = p === null || p === undefined ? COL.muted : p <= sim.slo[inst.model] ? COL.ok : COL.bad;
      fits = [[['p99 ' + v, pCol], [' / ' + slo, COL.muted], [' · ' + kvTxt, kvCol]],
              [['p99 ' + v, pCol], [' / ' + slo, COL.muted]],
              [[v, pCol], ['/' + slo, COL.muted]]];
    } else {
      fits = [[['running ' + n + ' · ' + kvTxt, kvCol]], [[n + ' · ' + kvTxt, kvCol]]];
    }
    var short = E.MODELS[inst.model].short, name = V.multi ? boxName(inst) + ' · ' + short : boxName(inst);
    var levels = fits.map(function (f) { return [name, f]; });
    if (V.multi) levels.push([short, fits[fits.length - 1]]);
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
  function drawHeader(h, level, b) {
    var right = (h.marker ? [h.marker] : []).concat(h.levels[level][1]), x = b.x + b.w - 7;
    text(h.levels[level][0], b.x + 7, b.y + 12, 9, COL.muted);
    for (var k = right.length - 1; k >= 0; k--) {   // right-aligned, last piece first
      text(right[k][0], x, b.y + 12, 9, right[k][1], 'right');
      x -= ctx.measureText(right[k][0]).width;
    }
  }

  function drawInstance(inst, b, rows, h, level) {
    ctx.strokeStyle = COL.lane; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
    rr(L.qx0 - 6, b.y, L.qx1 - L.qx0 + 12, b.h, 6); ctx.stroke(); ctx.setLineDash([]);

    rr(b.x, b.y, b.w, b.h, 6); ctx.fillStyle = COL.box; ctx.fill(); ctx.strokeStyle = COL.line; ctx.stroke();
    var kv = h.kv, hot = h.hot;
    drawHeader(h, level, b);

    var show = drawn(b, rows.length);
    for (var j = 0; j < show; j++) drawRow(inst, b, rows[j]);
    if (rows.length > b.cap) {   // on its own line below the last drawn row (two row lines tall)
      text('+' + (rows.length - show) + ' more', b.bx, lineY(b, show) + 7.5, 8, COL.faint);
    } else if (rows.length < b.cap && E.canAdmit(sim, inst)) {   // a free slot: the next request to arrive joins at the next step
      ctx.strokeStyle = COL.free; ctx.setLineDash([2, 2]);
      rr(b.bx + 0.5, lineY(b, rows.length) + 0.5, b.bw * 0.22, ROW_H - 1, 1.5); ctx.stroke(); ctx.setLineDash([]);
    }

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

    ctx.strokeStyle = COL.ok; ctx.setLineDash([2, 2]);
    sim.events.forEach(function (ev) {
      if (ev.t < h[0].t) return;   // scrolled off the left
      for (i = 0; i < n && h[i].t < ev.t; i++);
      var x = Math.round(xs(Math.min(i, n - 1))) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, by + 3); ctx.lineTo(x, by + 25); ctx.stroke();
      ctx.font = '8px ' + FONT;
      var w = ctx.measureText(ev.label).width, left = x + 5 + w > x1, lx = left ? x - 5 - w : x + 5;
      ctx.fillStyle = COL.panel;   // the label sits on a patch of panel, so the line never runs through it
      ctx.fillRect(lx - 2, by + 4, w + 4, 9);
      text(ev.label, lx, by + 11, 8, COL.ok);
    });
    ctx.setLineDash([]);
  }

  function draw() {
    if (!W || !L) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = COL.grid;
    for (var gx = 8; gx < W; gx += 16) for (var gy = 8; gy < L.bot + 4; gy += 16) ctx.fillRect(gx, gy, 1, 1);
    var narrow = W <= 560;
    ctx.font = '10px ' + FONT;
    text(10 + ctx.measureText('requests →').width + 6 > L.qx0 - 4 ? 'requests' : 'requests →', 10, 16, 10, COL.faint);
    text(narrow ? 'queue' : 'router · queue', L.qx0 - 4, 16, 10, COL.faint);
    text(narrow ? VIEWS[preset].narrow : VIEWS[preset].label, L.gx0, 16, 10, COL.faint);
    if (W > 420) text('tokens →', L.gx1 + 10, 16, 10, COL.faint);
    // every box's header at the same level, so their names and pieces match
    var heads = sim.instances.map(header), level = 0;
    heads.forEach(function (h, ii) { level = Math.max(level, fitLevel(h, L.boxes[ii])); });
    sim.instances.forEach(function (inst, ii) { drawInstance(inst, L.boxes[ii], V.rows[ii], heads[ii], level); });
    drawDots();
    drawStream();
    drawStrip();
  }

  // ---- Footer and play button ----

  // The canvas's aria-label in tab 03: the view, then each model's p99 against its target, as the boxes show it
  function sloLabel() {
    return VIEWS[preset].aria + '. ' + Object.keys(sim.slo).map(function (model) {
      var p = V.p99[model], slo = sim.slo[model];
      return E.MODELS[model].short + ' p99 ' + E.fmt.spoken(p) + ', target ' + E.fmt.spoken(slo) +
        (p === null ? '' : p <= slo ? ', met' : ', missed');
    }).join('; ');
  }
  function footer() {
    var m = E.metrics(sim), f = E.fmt;
    if (sim.slo) {   // each box's p99 against its SLO, refreshed with the footer, and the same in words
      Object.keys(sim.slo).forEach(function (model) { V.p99[model] = E.metrics(sim, model, P99_WINDOW_MS).ttftP99; });
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
  // Batching follows the sim; the deployment follows the preset, MIG while tab 03 isn't open
  function syncRadios() {
    check(batchRadios, 'data-batching', sim.batching);
    check(deployRadios, 'data-deploy', preset.indexOf('mig-') === 0 ? preset.slice(4) : 'mig');
  }

  // A redeploy: builds the preset with a fresh seed and warms it up, so it opens mid-flow (tab 03, whose
  // boxes show a 30 s p99, for longer). Nothing of the old sim's view carries over, and frozen stays as it
  // is (reduced motion opens every one frozen).
  function deploy(id, config) {
    preset = id;
    sim = E.createSim(Object.assign({}, E.PRESETS[id], { seed: Math.floor(Math.random() * 2147483647), config: config }));
    V = freshView();
    for (var k = 0, n = sim.slo ? TAB03_WARMUP_TICKS : WARMUP_TICKS; k < n; k++) {
      E.tick(sim, TICK_MS);
      if (sim.t >= V.nextSample) { V.nextSample += SAMPLE_MS; sample(E.metrics(sim)); }
    }
    V.rejected = sim.stats.rejected;
    note.textContent = VIEWS[id].note;
    cv.setAttribute('aria-label', VIEWS[id].aria);
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

  // Opens a tab with its controls at their defaults: continuous batching, the slider at 0.9, MIG
  function switchTab(id) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === id;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    panels.forEach(function (p) { p.hidden = p.getAttribute('data-tab') !== id; });
    kvMem.value = String(KV_MEM);
    kvMemOut.textContent = KV_MEM.toFixed(2);
    if (id === 'kvcache') deploy('kvcache', { gpuMemUtil: KV_MEM });
    else deploy(id === 'mig' ? 'mig-mig' : 'batching');
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
  // The output follows the slider as it moves; a redeploy waits for the change (release, or a key step),
  // since --gpu-memory-utilization is a startup flag
  kvMem.addEventListener('input', function () { kvMemOut.textContent = (+kvMem.value).toFixed(2); });
  kvMem.addEventListener('change', function () {
    kvMemOut.textContent = (+kvMem.value).toFixed(2);
    deploy('kvcache', { gpuMemUtil: +kvMem.value });
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
    E.sendBurst(sim, BURST, 0);   // stream 0: tab 03's 8B
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
