// Architecture map: the whole system as a row of components, always on the canvas.
// state per component: lit (introduced on this step, solid step color), built (earlier step), ghost (later step).
// def: [{ id, label, level }]   current: step number, or 'all' (every component lit in its own step color)
import { el } from './util.js';

const LEVEL_COLOR = { 0: 'ink', 1: 'blue', 2: 'red', 3: 'yellow', 4: 'green', 5: 'blue' };

export function renderMap(def, current, { variant = 'strip' } = {}) {
  const all = current === 'all';
  const row = el('div', { class: `archmap archmap-${variant}`, role: 'img', 'aria-label': all ? 'Architecture: all five steps' : `Architecture, step ${current}` });
  def.forEach((c, i) => {
    let state = 'ghost';
    if (all || c.level === current) state = 'lit';
    else if (c.level < current) state = 'built';
    if (i) row.append(el('span', { class: `am-link ${state === 'ghost' ? 'ghost' : ''}`, 'aria-hidden': 'true' }));
    row.append(el('span', { class: `am-chip ${state} c-${LEVEL_COLOR[c.level]}`, 'data-level': c.level }, c.label));
  });
  return row;
}

// Five-step indicator: the talk's structure, not the system's components.
// steps: [{ n, name, color }]  current: 0..5 or 'all'   style: 'bar' (five labeled segments) | 'tiles' (numbered squares + current name)
export function renderSteps(steps, current, { variant = 'strip', style = 'bar' } = {}) {
  const all = current === 'all';
  const row = el('div', { class: `steps steps-${style} steps-${variant}`, role: 'img', 'aria-label': all ? 'The five steps' : `Step ${current} of 5` });
  for (const s of steps) {
    const state = all || s.n === current ? 'now' : s.n < current ? 'done' : 'next';
    const showName = style === 'bar' || state === 'now' || all;
    row.append(el('span', { class: `step ${state} c-${s.color}` }, [
      el('b', {}, String(s.n)),
      showName ? el('span', { class: 'step-name' }, s.name) : null,
    ]));
  }
  return row;
}
