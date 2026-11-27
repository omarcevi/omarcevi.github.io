// Passphrase gate + presenter sign-in, shared by /present/, /remote/, /notes/, /stats/.
import { deriveKey, decryptDeck, storeKey, loadKey } from './crypto.js';
import { PRESENTER_UID } from './config.js';
import { el } from './util.js';

function gate(title) {
  const root = el('div', { class: 'gate', role: 'dialog', 'aria-modal': 'true' });
  const box = el('div', { class: 'gate-box' }, [el('p', { class: 'gate-eyebrow' }, title), el('div', { class: 'gate-body' })]);
  root.append(box);
  document.body.append(root);
  return { root, body: box.querySelector('.gate-body'), close: () => root.remove() };
}

const sessKey = (talkId) => `deck:${talkId}`;

export async function unlockDeck(talkId, { deckUrl = '../deck.enc', title = 'Presenter' } = {}) {
  let blob = null;
  try {
    const r = await fetch(deckUrl, { cache: 'no-cache' });
    if (r.ok) blob = await r.json();
  } catch { /* offline: fall back to the session copy */ }

  try {
    const s = JSON.parse(sessionStorage.getItem(sessKey(talkId)) || 'null');
    if (s && (!blob || blob.salt === s.salt)) return s.deck;
  } catch { /* ignore */ }

  if (!blob) {
    const g = gate(title);
    g.body.append(el('p', { class: 'gate-msg' }, 'Deck unavailable offline. Connect once to unlock it.'));
    return new Promise(() => {});
  }

  const keyId = `${talkId}:${blob.salt}`;
  const remembered = await loadKey(keyId);
  if (remembered) {
    try { return keep(talkId, blob, await decryptDeck(blob, remembered)); } catch { /* deck rebuilt or key wrong */ }
  }

  const g = gate(title);
  const input = el('input', { type: 'password', class: 'gate-input', autocomplete: 'current-password', 'aria-label': 'Passphrase', placeholder: 'Passphrase' });
  const remember = el('input', { type: 'checkbox', id: 'gate-remember', checked: '' });
  const msg = el('p', { class: 'gate-msg', 'aria-live': 'polite' });
  const btn = el('button', { class: 'gate-btn', type: 'submit' }, 'Unlock');
  const form = el('form', { class: 'gate-form' }, [
    input,
    el('label', { class: 'gate-check', for: 'gate-remember' }, [remember, ' Remember on this device']),
    btn, msg,
  ]);
  g.body.append(form);
  input.focus();
  return new Promise((resolve) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value) return;
      btn.disabled = true; msg.textContent = 'Unlocking…';
      try {
        const key = await deriveKey(input.value, blob.salt, blob.iter);
        const deck = await decryptDeck(blob, key);
        if (remember.checked) await storeKey(keyId, key);
        input.value = '';
        g.close();
        resolve(keep(talkId, blob, deck));
      } catch {
        msg.textContent = 'Wrong passphrase.';
        btn.disabled = false; input.select();
      }
    });
  });
}

function keep(talkId, blob, deck) {
  try { sessionStorage.setItem(sessKey(talkId), JSON.stringify({ salt: blob.salt, deck })); } catch { /* quota */ }
  return deck;
}

// Resolves with the signed-in presenter user, or null if the presenter chose to continue without sync.
export function presenterSignIn(fb, { allowSkip = false, title = 'Presenter' } = {}) {
  const { A, auth } = fb;
  return new Promise((resolve) => {
    let g = null;
    const off = A.onAuthStateChanged(auth, (u) => {
      if (u && !u.isAnonymous) {
        if (g) g.close();
        off();
        resolve(u);
        return;
      }
      if (g) return;
      g = gate(title);
      const msg = el('p', { class: 'gate-msg', 'aria-live': 'polite' });
      const signIn = el('button', { class: 'gate-btn', type: 'button' }, 'Sign in to present');
      signIn.addEventListener('click', async () => {
        msg.textContent = '';
        try {
          if (fb.emu) {
            // Emulator only: deterministic fake Google account for local runs and Playwright.
            const cred = A.GoogleAuthProvider.credential(JSON.stringify({ sub: 'presenter-e2e', email: 'presenter@example.com', email_verified: true }));
            await A.signInWithCredential(auth, cred);
          } else {
            await A.signInWithPopup(auth, new A.GoogleAuthProvider());
          }
        } catch (e) { msg.textContent = `Sign-in failed (${e.code || 'error'}).`; }
      });
      g.body.append(signIn);
      if (allowSkip) {
        const skip = el('button', { class: 'gate-link', type: 'button' }, 'Continue without live sync');
        skip.addEventListener('click', () => { g.close(); off(); resolve(null); });
        g.body.append(skip);
      }
      g.body.append(msg);
    });
  });
}

export function isPresenterUser(u) {
  return !!u && !u.isAnonymous && (PRESENTER_UID === 'PRESENTER_UID_PLACEHOLDER' || u.uid === PRESENTER_UID);
}
