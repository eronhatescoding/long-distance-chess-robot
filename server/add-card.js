// server/add-card.js — assign an RFID card to a player.
// Usage: node server/add-card.js <cardId> <email-or-uid>
//   node server/add-card.js 04A3B2C1 testplayer1@robotchess.dev
// The card id is normalized to uppercase hex — the same rule the tap
// endpoint applies to reader output, so either format works here.

'use strict';

const { firebaseCredentials } = require('./env');

const [cardIdRaw, who] = process.argv.slice(2);
if (!cardIdRaw || !who) {
  console.error('usage: node server/add-card.js <cardId> <email-or-uid>');
  process.exit(1);
}

const cardId = cardIdRaw.toUpperCase().replace(/[^0-9A-F]/g, '');
if (!cardId) {
  console.error(`"${cardIdRaw}" has no hex digits — that can't be a card id`);
  process.exit(1);
}

const creds = firebaseCredentials();
if (!creds) {
  console.error('no firebase credentials found (.env or server/service-account.json)');
  process.exit(1);
}

const { initializeApp, cert } = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp({ credential: cert(creds) });
const auth = getAuth();
const db = getFirestore();

async function main() {
  let uid = who;
  if (who.includes('@')) {
    uid = (await auth.getUserByEmail(who)).uid;
  } else {
    await auth.getUser(who); // validate the uid exists
  }
  await db.collection('cards').doc(cardId).set({
    uid,
    assignedAt: FieldValue.serverTimestamp(),
  });
  console.log(`card ${cardId} -> ${uid}${who.includes('@') ? ` (${who})` : ''}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`failed: ${err.message}`);
    process.exit(1);
  });
