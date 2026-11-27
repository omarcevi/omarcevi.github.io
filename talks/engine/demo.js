// Scripted demo player: a chat panel + an "under the hood" panel, one beat per click.
// Pure playback from data (deck.demos[id].beats). Step k shows beats[0..k-1]; going back re-renders cleanly.
//
// Beat kinds (one key per beat):
//   { user: "text" }                         user bubble
//   { typing: true }                          assistant typing indicator (removed by the next assistant beat)
//   { bot: "text", id?, draft?, confirm? }    assistant bubble, streamed token by token when reached going forward
//   { mark: { msg, phrase, label } }          red stamp over a phrase of an earlier message
//   { replace: { msg, phrase, with, label } } rewrite a phrase (e.g. redaction) with a stamp
//   { pick: { msg, choice } }                 highlight a confirm button ("yes"/"no")
//   { source: { msg, text } }                 source chip under a message
//   { card: { eyebrow, title, body, list, chips, flow, active, tone, fill, mono, status } }  inspection panel card
//   { caption: "text" }                       big caption under the demo
import { el } from './util.js';

export class DemoPlayer {
  constructor(root, demo) {
    this.root = root; this.demo = demo || { beats: [] }; this.timers = [];
    root.classList.add('demo');
    this.chat = el('div', { class: 'chat-log' });
    this.panel = el('div', { class: 'insp-cards' });
    this.caption = el('p', { class: 'demo-caption' });
    const d = this.demo;
    root.replaceChildren(
      el('div', { class: 'phone-frame' }, [
        el('div', { class: 'phone-head' }, [
          el('span', { class: 'phone-avatar', 'aria-hidden': 'true' }, d.avatar || 'EP'),
          el('div', {}, [el('p', { class: 'phone-name' }, d.app || 'Assistant'), el('p', { class: 'phone-status' }, d.status || 'online')]),
        ]),
        this.chat,
      ]),
      el('div', { class: 'insp' }, [
        el('p', { class: 'eyebrow insp-title' }, d.panelTitle || 'Under the hood'),
        this.panel,
        d.illustrative !== false ? el('p', { class: 'illustrative' }, 'Illustrative') : null,
      ]),
      this.caption,
    );
  }

  get steps() { return this.demo.beats.length; }

  go(step, prevStep) {
    this.timers.forEach(clearTimeout); this.timers = [];
    const animate = prevStep != null && step === prevStep + 1;
    this.chat.replaceChildren(); this.panel.replaceChildren(); this.caption.textContent = ''; this.caption.classList.remove('on');
    this.msgs = {};
    const beats = this.demo.beats.slice(0, step);
    beats.forEach((b, i) => this.apply(b, animate && i === beats.length - 1, i));
    // drop a typing indicator that was followed by an assistant message
    this.chat.scrollTop = this.chat.scrollHeight;
  }

  bubble(cls, text, id) {
    const body = el('p', { class: 'bubble-text' }, text);
    const n = el('div', { class: `bubble ${cls}` }, body);
    this.chat.append(n);
    if (id) this.msgs[id] = n;
    return n;
  }

  apply(b, animate, i) {
    const enter = (n) => { if (animate) n.classList.add('enter'); return n; };
    if (b.user != null) enter(this.bubble('user', b.user, b.id || `m${i}`));
    else if (b.typing) enter(this.chat.appendChild(el('div', { class: 'bubble bot typing', 'aria-label': 'typing' }, [el('i'), el('i'), el('i')])));
    else if (b.bot != null) {
      this.chat.querySelectorAll('.typing').forEach((t) => t.remove());
      const n = enter(this.bubble(`bot${b.draft ? ' draft' : ''}`, '', b.id || `m${i}`));
      if (b.draft) n.prepend(el('p', { class: 'draft-tag' }, 'Draft (not sent)'));
      const textEl = n.querySelector('.bubble-text');
      const done = () => {
        textEl.textContent = b.bot;
        if (b.confirm) {
          n.append(el('div', { class: 'confirm' }, [
            el('button', { class: 'confirm-btn yes', 'data-choice': 'yes', tabindex: '-1' }, b.confirm.yes || 'Yes'),
            el('button', { class: 'confirm-btn no', 'data-choice': 'no', tabindex: '-1' }, b.confirm.no || 'No'),
          ]));
        }
        this.chat.scrollTop = this.chat.scrollHeight;
      };
      if (animate) this.stream(textEl, b.bot, done); else done();
    } else if (b.mark) this.stamp(b.mark, animate);
    else if (b.replace) this.stamp(b.replace, animate, true);
    else if (b.pick) {
      const m = this.msgs[b.pick.msg];
      m?.querySelector(`.confirm-btn[data-choice="${b.pick.choice}"]`)?.classList.add('picked');
    } else if (b.source) {
      const m = this.msgs[b.source.msg];
      if (m) m.append(enter(el('span', { class: 'source-chip' }, b.source.text)));
    } else if (b.card) this.card(b.card, animate);
    else if (b.caption) { this.caption.textContent = b.caption; this.caption.classList.add('on'); if (animate) this.caption.classList.add('enter'); }
    this.chat.scrollTop = this.chat.scrollHeight;
  }

  stream(target, text, done) {
    const tokens = text.match(/\S+\s*/g) || [text];
    let k = 0;
    target.textContent = '';
    const tick = () => {
      k += 1;
      target.textContent = tokens.slice(0, k).join('');
      this.chat.scrollTop = this.chat.scrollHeight;
      if (k < tokens.length) this.timers.push(setTimeout(tick, 1000 / 28));
      else done();
    };
    tick();
  }

  // Wrap a phrase of an earlier message and attach a stamp label (and optionally rewrite it).
  stamp({ msg, phrase, label, with: replacement }, animate, rewrite = false) {
    const t = this.msgs[msg]?.querySelector('.bubble-text');
    if (!t) return;
    // split the text node that contains the phrase (keeps earlier stamps intact)
    const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest('mark')) continue;
      const at = node.data.indexOf(phrase);
      if (at < 0) continue;
      const mark = el('mark', { class: `stamp${rewrite ? ' rewrite' : ''}${animate ? ' enter' : ''}`, 'data-label': label || '' }, rewrite ? replacement : phrase);
      const rest = node.splitText(at);
      rest.data = rest.data.slice(phrase.length);
      node.after(mark);
      return;
    }
  }

  card(c, animate) {
    const kids = [];
    if (c.eyebrow) kids.push(el('p', { class: 'card-eyebrow' }, c.eyebrow));
    if (c.title) kids.push(el('p', { class: `card-title${c.mono ? ' mono' : ''}` }, [c.title, c.status ? el('span', { class: 'card-status' }, c.status) : null]));
    if (c.flow) kids.push(el('div', { class: 'flow' }, c.flow.flatMap((f, i) => [i ? el('span', { class: 'flow-arrow', 'aria-hidden': 'true' }, '→') : null, el('span', { class: `flow-step${c.active === i ? ' active' : ''}` }, f)])));
    if (c.body) kids.push(el('p', { class: 'card-body' }, c.body));
    if (c.list) kids.push(el('ol', { class: 'card-list' }, c.list.map((x) => el('li', {}, x))));
    if (c.chips) kids.push(el('div', { class: 'chips' }, c.chips.map((x) => el('span', { class: 'chip' }, x))));
    const n = el('div', { class: `card tone-${c.tone || 'neutral'}${c.fill ? ' fill' : ''}${animate ? ' enter' : ''}` }, kids);
    this.panel.append(n);
    // newest card always visible: drop the oldest ones that no longer fit
    while (this.panel.children.length > 1 && this.panel.scrollHeight > this.panel.clientHeight + 2) this.panel.firstElementChild.remove();
  }
}
