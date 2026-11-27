// Encrypted deck: AES-GCM-256, key = PBKDF2-SHA256(passphrase, random salt, >= 600k iterations).
// Format of deck.enc (JSON): { v, alg, kdf, iter, salt, iv, aad, ct } with base64 fields.
// Mirrors scripts/build-deck.mjs in the private talk-decks repo.
const te = new TextEncoder();
const td = new TextDecoder();
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function deriveKey(passphrase, saltB64, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64(saltB64), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable: IndexedDB can store it, nobody can export it
    ['decrypt'],
  );
}

export async function decryptDeck(blob, key) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64(blob.iv), additionalData: te.encode(blob.aad) },
    key,
    b64(blob.ct),
  );
  return JSON.parse(td.decode(pt));
}

// ---- "Remember on this device": the derived CryptoKey in IndexedDB, keyed by talk + salt ----
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('talk-keys', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function storeKey(id, key) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction('keys', 'readwrite');
      tx.objectStore('keys').put(key, id);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch { /* private mode: just ask again next time */ }
}
export async function loadKey(id) {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const r = db.transaction('keys').objectStore('keys').get(id);
      r.onsuccess = () => res(r.result || null); r.onerror = () => res(null);
    });
  } catch { return null; }
}
export async function forgetKeys() {
  try {
    const db = await idb();
    db.transaction('keys', 'readwrite').objectStore('keys').clear();
  } catch { /* ignore */ }
  try { Object.keys(sessionStorage).filter((k) => k.startsWith('deck:')).forEach((k) => sessionStorage.removeItem(k)); } catch { /* ignore */ }
}
