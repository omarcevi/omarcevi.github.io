// Growing architecture diagram. Data (nodes/edges with a `level`) lives in the encrypted deck;
// this renderer shows everything up to `level` and animates what is new since `animateFrom`.
import { svg } from './util.js';

const LEVEL_COLOR = { 0: 'neutral', 1: 'blue', 2: 'red', 3: 'yellow', 4: 'green', 5: 'blue' };
const COLORS = { neutral: '#c7ccd2', blue: '#57caff', red: '#ff7daf', yellow: '#ffd427', green: '#5cdb6d' };

export function renderDiagram(slot, def, { level = 5, animateFrom = level - 1, tags = false } = {}) {
  if (!def) return;
  const [W, H] = def.viewBox;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dg', role: 'img', 'aria-label': `Architecture diagram, step ${level}` });
  const defs = svg('defs');
  for (const [name, col] of Object.entries(COLORS)) {
    defs.append(svg('marker', { id: `dg-arrow-${name}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: col })));
  }
  root.append(defs);
  const gLoops = svg('g'), gEdges = svg('g'), gNodes = svg('g'), gTags = svg('g');
  root.append(gLoops, gEdges, gNodes, gTags);
  const colorOf = (o) => o.tone || LEVEL_COLOR[o.level] || 'neutral';
  const isNew = (o) => o.level > animateFrom && o.level === level;
  // build-instructions grammar: earlier layers recede, the layer this slide adds is bright
  const prior = (o) => !tags && level > 0 && o.level < level;

  for (const e of def.edges) {
    if (e.level > level) continue;
    const c = colorOf(e);
    const d = e.pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
    const path = svg('path', {
      d, class: `dg-edge${e.dashed ? ' dashed' : ''}${isNew(e) ? ' enter' : ''}${prior(e) ? ' prior' : ''}`, stroke: COLORS[c],
      'marker-end': e.noArrow ? null : `url(#dg-arrow-${c})`, 'marker-start': e.both ? `url(#dg-arrow-${c})` : null,
    });
    gEdges.append(path);
    if (e.label) gEdges.append(svg('text', { x: e.label[1], y: e.label[2], class: `dg-edge-label${isNew(e) ? ' enter' : ''}`, fill: COLORS[c], 'text-anchor': e.label[3] || 'middle' }, e.label[0]));
  }

  for (const n of def.nodes) {
    if (n.level > level) continue;
    const c = colorOf(n);
    const g = svg('g', { class: `dg-node k-${n.kind || 'box'} c-${c}${isNew(n) ? ' enter' : ''}${prior(n) ? ' prior' : (n.level === level && level > 0 && !tags ? ' current' : '')}`, 'data-id': n.id });
    const target = n.kind === 'loop' ? gLoops : gNodes;
    if (n.kind === 'loop') {
      g.append(svg('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 28, class: 'dg-loop', stroke: COLORS[c] }));
      g.append(svg('text', { x: n.x + 24, y: n.y + 34, class: 'dg-loop-label', fill: COLORS[c] }, n.label));
    } else {
      g.append(svg('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: n.kind === 'chip' ? 10 : 16, class: 'dg-box', stroke: COLORS[c], style: `--flash:${COLORS[c]}` }));
      const lines = String(n.label).split('\n');
      const subLines = n.sub ? String(n.sub).split('\n') : [];
      const lh = n.kind === 'chip' ? 24 : 32, slh = 24;
      const total = lines.length * lh + subLines.length * slh;
      let y = n.top ? n.y + 40 : n.y + n.h / 2 - total / 2 + lh * 0.75;
      for (const l of lines) { g.append(svg('text', { x: n.x + n.w / 2, y, class: n.kind === 'chip' ? 'dg-chip-label' : 'dg-label', 'text-anchor': 'middle' }, l)); y += lh; }
      y += 2;
      for (const l of subLines) { g.append(svg('text', { x: n.x + n.w / 2, y: y - 6, class: 'dg-sub', 'text-anchor': 'middle' }, l)); y += slh; }
    }
    target.append(g);
    if (tags && n.level > 0 && !n.noTag) {
      const tx = n.x + (n.kind === 'loop' ? n.w - 4 : 0), ty = n.y;
      gTags.append(svg('g', { class: 'dg-tag' }, [
        svg('circle', { cx: tx, cy: ty, r: 19, fill: COLORS[c] }),
        svg('text', { x: tx, y: ty + 7, 'text-anchor': 'middle', class: 'dg-tag-n' }, String(n.level)),
      ]));
    }
  }
  slot.replaceChildren(root);
}
