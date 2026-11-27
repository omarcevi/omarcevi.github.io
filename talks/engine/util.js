import qrcode from './vendor/qrcode.mjs';

// Tiny DOM helper. Strings become text nodes (never innerHTML).
export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, children = []) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) n.setAttribute(k, v);
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

// QR code as an <svg> (white tile, navy modules), crisp at any scale.
export function qrSvg(text, { ecc = 'M', margin = 2 } = {}) {
  const q = qrcode(0, ecc);
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const size = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + margin},${r + margin}h1v1h-1z`;
  const s = svg('svg', { viewBox: `0 0 ${size} ${size}`, class: 'qr', 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': `QR code: ${text}` });
  s.append(svg('rect', { width: size, height: size, fill: '#ffffff' }), svg('path', { d, fill: '#20344b' }));
  return s;
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
  d.flush = (...a) => { if (t) { clearTimeout(t); t = null; fn(...a); } };
  return d;
}

export function randomCode(len = 6) {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const v = crypto.getRandomValues(new Uint32Array(len));
  return Array.from(v, (x) => abc[x % abc.length]).join('');
}

export function newRunId() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `r${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomCode(3).toLowerCase()}`;
}

export const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
