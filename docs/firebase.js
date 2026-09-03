/* ── MERIDIAN · Firestore sync ───────────────────────────────────────
   Loaded as a module. Publishes window.FB, then fires 'fb-ready' — which
   is what app.js waits for.

   The config below is NOT a secret. A Firebase web API key is a project
   identifier, not a credential, and is meant to ship in client code. What
   actually protects the data is the Firestore rule allowing a signed-in
   user to touch only users/{their own uid}.

   State is stored as ONE JSON string field rather than a nested map: our
   keys look like "w07.1", and dots are awkward in Firestore field paths.
   A string sidesteps that and keeps all merging in JS, where it already
   works and is already tested.
   ------------------------------------------------------------------ */

const SDK = 'https://www.gstatic.com/firebasejs/12.3.0';

const { initializeApp } = await import(`${SDK}/firebase-app.js`);
const {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence,
} = await import(`${SDK}/firebase-auth.js`);
const { getFirestore, doc, getDoc, setDoc, onSnapshot } =
  await import(`${SDK}/firebase-firestore.js`);

const app = initializeApp({
  apiKey: 'AIzaSyAVEsF7Qer8I72FddoDwYP0ykgiqJ01UXs',
  authDomain: 'meridian-a4947.firebaseapp.com',
  projectId: 'meridian-a4947',
  storageBucket: 'meridian-a4947.firebasestorage.app',
  messagingSenderId: '1073878954730',
  appId: '1:1073878954730:web:a15199723cc44d66621d93',
});

const auth = getAuth(app);
const db   = getFirestore(app);

await setPersistence(auth, browserLocalPersistence).catch(() => {});
getRedirectResult(auth).catch(() => {});      // completes a popup-blocked fallback

const ref = uid => doc(db, 'users', uid, 'meridian', 'state');

window.FB = {
  user: () => auth.currentUser,
  onAuth: cb => onAuthStateChanged(auth, cb),

  async signIn() {
    const p = new GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'select_account' });   // you have several Google accounts
    try {
      return await signInWithPopup(auth, p);
    } catch (e) {
      // iOS Safari and popup blockers land here; redirect always works
      if (/popup-blocked|popup-closed|cancelled-popup|operation-not-supported/.test(e.code || '')) {
        return signInWithRedirect(auth, p);
      }
      throw e;
    }
  },

  signOut: () => signOut(auth),

  /** Read once. Parsed state, or null if nothing is saved yet. */
  async load(uid) {
    const s = await getDoc(ref(uid));
    if (!s.exists()) return null;
    try { return JSON.parse(s.data().doc); } catch { return null; }
  },

  /** Overwrite the remote doc. Callers merge before calling this. */
  save(uid, st) {
    return setDoc(ref(uid), {
      doc: JSON.stringify(st),
      updatedAt: st.updatedAt || Date.now(),
      v: 1,
    });
  },

  /** Live updates from your other devices. */
  watch(uid, cb) {
    return onSnapshot(ref(uid), snap => {
      if (!snap.exists()) return;
      if (snap.metadata.hasPendingWrites) return;   // our own write echoing back
      try { cb(JSON.parse(snap.data().doc)); } catch {}
    }, () => {});
  },
};

window.dispatchEvent(new Event('fb-ready'));
