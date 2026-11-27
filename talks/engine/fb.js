// Lazy Firebase loader. Slides never depend on this: it is imported dynamically and any failure
// (offline, CDN blocked) only turns the live features off.
import { SDK, FIREBASE, APPCHECK_SITE_KEY, useEmulator, EMULATOR } from './config.js';

let pending = null;

export function loadFirebase() {
  if (pending) return pending;
  pending = (async () => {
    const emu = useEmulator();
    const [A, F, appM] = await Promise.all([
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
      import(`${SDK}/firebase-app.js`),
    ]);
    const cfg = emu ? { ...FIREBASE, projectId: EMULATOR.projectId } : FIREBASE;
    const app = appM.initializeApp(cfg);
    if (!emu) {
      // App Check (reCAPTCHA Enterprise). Enforced on Firestore, so scripts with the public config get nothing.
      // Local dev against production: set self.FIREBASE_APPCHECK_DEBUG_TOKEN before load (never committed).
      // localhost?prod: the reCAPTCHA key only allows omarcevi.dev, so local runs use a private debug token
      // stored by hand in this browser (localStorage 'appcheck-debug'); it never ships in the code.
      if (['localhost', '127.0.0.1'].includes(location.hostname)) {
        try { const t = localStorage.getItem('appcheck-debug'); if (t) self.FIREBASE_APPCHECK_DEBUG_TOKEN = t; } catch { /* ignore */ }
      }
      const AC = await import(`${SDK}/firebase-app-check.js`);
      AC.initializeAppCheck(app, {
        provider: new AC.ReCaptchaEnterpriseProvider(APPCHECK_SITE_KEY),
        isTokenAutoRefreshEnabled: true,
      });
    }
    // keep the login on this device (IndexedDB, falling back to localStorage) so the presenter signs in once
    const auth = A.initializeAuth(app, {
      persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence],
      popupRedirectResolver: A.browserPopupRedirectResolver,
    });
    const db = F.initializeFirestore(app, { ignoreUndefinedProperties: true });
    if (emu) {
      A.connectAuthEmulator(auth, `http://${EMULATOR.host}:${EMULATOR.authPort}`, { disableWarnings: true });
      F.connectFirestoreEmulator(db, EMULATOR.host, EMULATOR.firestorePort);
    }
    return { app, auth, db, A, F, emu };
  })();
  pending.catch(() => { pending = null; });
  return pending;
}

export function waitForUser(fb) {
  return new Promise((resolve) => {
    const off = fb.A.onAuthStateChanged(fb.auth, (u) => { off(); resolve(u); });
  });
}

export const paths = {
  talk: (t) => `talks/${t}`,
  run: (t, r) => `talks/${t}/runs/${r}`,
  control: (t, r) => `talks/${t}/runs/${r}/private/control`,
  secret: (t, r) => `talks/${t}/runs/${r}/private/secret`,
  heartbeat: (t, r) => `talks/${t}/runs/${r}/private/heartbeat`,
  poll: (t, r, p) => `talks/${t}/runs/${r}/polls/${p}`,
  votes: (t, r, p) => `talks/${t}/runs/${r}/polls/${p}/votes`,
  vote: (t, r, p, u) => `talks/${t}/runs/${r}/polls/${p}/votes/${u}`,
  reactions: (t, r) => `talks/${t}/runs/${r}/reactions`,
  reaction: (t, r, id) => `talks/${t}/runs/${r}/reactions/${id}`,
  lastReaction: (t, r, u) => `talks/${t}/runs/${r}/lastReaction/${u}`,
  joinedCol: (t, r) => `talks/${t}/runs/${r}/joined`,
  joined: (t, r, u) => `talks/${t}/runs/${r}/joined/${u}`,
};
