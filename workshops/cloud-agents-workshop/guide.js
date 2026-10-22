// Shared behaviour for the cloud-agents-workshop guide pages (copy buttons, done marks,
// section highlighting, theme toggle). Adapted from workshops/adk-multi-agent-workshop.
(() => {
  // Copy buttons on code blocks and prompts
  const copy = (btn, text) => {
    const done = () => { btn.textContent = 'copied'; btn.classList.add('ok');
      setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('ok'); }, 1400); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
  };
  document.querySelectorAll('.code').forEach(block => {
    const b = document.createElement('button'); b.className = 'copy'; b.type = 'button'; b.textContent = 'copy';
    b.addEventListener('click', () => {
      const pre = block.querySelector('pre').cloneNode(true);
      pre.querySelectorAll('.c').forEach(c => c.remove());           // drop comments
      const text = pre.textContent.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l).join('\n');
      copy(b, text);
    });
    block.appendChild(b);
  });
  document.querySelectorAll('.prompts li').forEach(li => {
    const b = document.createElement('button'); b.className = 'copy'; b.type = 'button'; b.textContent = 'copy';
    b.addEventListener('click', () => copy(b, li.querySelector('q').textContent));
    li.appendChild(b);
  });

  // "done" checkboxes, remembered in this browser only
  const KEY = 'deploy-agents-workshop-done';   // old key kept so done marks survive the move
  let state = {};
  try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { state = {}; }
  const mark = () => document.querySelectorAll('.toc a[data-mod]').forEach(a =>
    a.classList.toggle('done', !!state[a.dataset.mod]));
  document.querySelectorAll('input[data-done]').forEach(cb => {
    cb.checked = !!state[cb.dataset.done];
    cb.addEventListener('change', () => {
      state[cb.dataset.done] = cb.checked;
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
      mark();
    });
  });
  mark();

  // Highlight the section you're reading in the side index
  const links = [...document.querySelectorAll('.toc a')];
  const byId = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
  const targets = [...byId.keys()].map(id => document.getElementById(id)).filter(Boolean);
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) {
        links.forEach(a => a.classList.remove('active'));
        byId.get(e.target.id)?.classList.add('active');
      }});
    }, { rootMargin: '-20% 0px -70% 0px' });
    targets.forEach(t => io.observe(t));
  }

  // Theme toggle: flips light/dark and remembers it (applyTheme and the saved choice are read in <head>)
  const btn = document.getElementById('theme-toggle'), root = document.documentElement;
  const os = window.matchMedia && matchMedia('(prefers-color-scheme: dark)');
  const current = () => root.getAttribute('data-theme') || (os && os.matches ? 'dark' : 'light');
  const label = () => {
    const l = `Switch to ${current() === 'dark' ? 'light' : 'dark'} theme`;
    btn.setAttribute('aria-label', l); btn.title = l;
  };
  btn.addEventListener('click', () => {
    const t = current() === 'dark' ? 'light' : 'dark';
    applyTheme(t);
    try { localStorage.setItem('theme', t); } catch (e) {}
    label();
  });
  if (os && os.addEventListener) os.addEventListener('change', label);
  label();
})();
