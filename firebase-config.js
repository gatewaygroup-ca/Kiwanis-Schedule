/* ============================================================
   FIREBASE CONFIG
   Realtime Database powers live, cross-device sync.
   Authentication powers the Admin / Client role split.

   This is a CLIENT-SIDE config object -- it is safe to publish
   in a public repo. It is NOT a secret. It only identifies which
   Firebase project to talk to; it grants no access by itself.
   Actual read/write permission is enforced by the Realtime
   Database Security Rules configured in the Firebase console
   (see firebase-database-rules.json in this repo + README).

   Do NOT put a Firebase Admin SDK service-account key here or
   anywhere in this repo -- that is a private server-side secret
   and is a completely different thing from this config object.
   ============================================================ */

const firebaseConfig = {
  apiKey: "AIzaSyD6fNaRHUGuHqNM9Y93TzKK5oybC_ZVqMk",
  authDomain: "munn-schedule.firebaseapp.com",
  databaseURL: "https://munn-schedule-default-rtdb.firebaseio.com",
  projectId: "munn-schedule",
  storageBucket: "munn-schedule.firebasestorage.app",
  messagingSenderId: "785773530393",
  appId: "1:785773530393:web:d3e4faccc8457277798988"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth();
