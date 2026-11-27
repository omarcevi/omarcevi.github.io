// Live-talk engine configuration. The Firebase web config is public by design:
// security comes from firestore.rules (presenter UID check) + App Check, not from hiding this.
export const SDK = 'https://www.gstatic.com/firebasejs/13.4.0';

export const FIREBASE = {
  apiKey: 'AIzaSyB58V3mFrVAP6EjdtLFSFEan57ijHBd7sQ',
  authDomain: 'omarcevi-live.firebaseapp.com',
  projectId: 'omarcevi-live',
  storageBucket: 'omarcevi-live.firebasestorage.app',
  messagingSenderId: '605527149812',
  appId: '1:605527149812:web:ef89ce46050eb32000e2a1',
};

// reCAPTCHA Enterprise site key registered with App Check (public by design).
export const APPCHECK_SITE_KEY = '6LdDNTUuAAAAADUagyObmh7FOIv_pB36mFItZGGN';

// UI hint only ("this account is not the presenter"). The real check is presenterUid() in the rules.
export const PRESENTER_UID = '2wGwIhZSnzYc30O4TXI6pKkLepm2';

export const SITE = 'https://omarcevi.dev';
export const SHORT_LIVE = 'omarcevi.dev/live';

// Local development: on localhost the engine talks to the Firebase emulators unless ?prod is in the URL
// (remembered for the tab). The emulators run from the private talk-decks repo: `npm run emu`.
export function useEmulator() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!local) return false;
  const q = new URLSearchParams(location.search);
  try {
    if (q.has('prod')) sessionStorage.setItem('live:prod', '1');
    if (q.has('emu')) sessionStorage.removeItem('live:prod');
    return sessionStorage.getItem('live:prod') !== '1';
  } catch { return !q.has('prod'); }
}
export const EMULATOR = { projectId: 'demo-talks', host: '127.0.0.1', firestorePort: 8081, authPort: 9099 };

// Fixed reaction map. The projector renders ONLY from this map; unknown keys are dropped.
export const REACTIONS = [
  { key: 'amazed', emoji: '🤯', en: 'amazed', tr: 'şaşkın' },
  { key: 'confused', emoji: '😕', en: 'confused', tr: 'kafam karıştı' },
  { key: 'interesting', emoji: '🤔', en: 'interesting', tr: 'ilginç' },
  { key: 'scary', emoji: '😱', en: 'scary', tr: 'korkutucu' },
  { key: 'party', emoji: '🎉', en: 'party', tr: 'parti' },
];
export const REACTION_BY_KEY = Object.fromEntries(REACTIONS.map((r) => [r.key, r]));
export const ACCENTS = ['blue', 'red', 'yellow', 'green', 'multi', 'none'];
export const REACTION_COOLDOWN_MS = 1500;
