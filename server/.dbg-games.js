// server/.dbg-games.js — dump the most recent games docs for debugging
'use strict';
const { firebaseCredentials } = require('./env');
const { initializeApp, cert } = require('firebase-admin');
initializeApp({ credential: cert(firebaseCredentials()) });
const db = require('firebase-admin/firestore').getFirestore();

db.collection('games').orderBy('startedAt', 'desc').limit(5).get().then((snap) => {
  for (const d of snap.docs) {
    const g = d.data();
    console.log(d.id, '|', g.names && `${g.names.A} vs ${g.names.B}`, '| status', g.status,
      '| result', g.result, '| uids', JSON.stringify(g.uids), '| moves', (g.moves || []).length,
      '| started', g.startedAt && g.startedAt.toMillis());
  }
  process.exit(0);
}).catch((err) => { console.error(err.message); process.exit(1); });
