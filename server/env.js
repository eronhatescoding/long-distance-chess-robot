// server/env.js — load secrets and build the Firebase Admin credential.
//
// Node >= 20.12 loads .env files natively (no dotenv dependency). Values
// from the shell/host always work too; the .env file is just for convenience.
//
// Credential sources, in priority order:
//   1. FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY env
//   2. server/service-account.json (the console download, gitignored)

const fs = require('fs');
const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // no .env — env vars may come from the shell or the host instead
}

function firebaseCredentials() {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    return {
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      // env files store the key with literal \n escapes; undo them
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }
  try {
    const sa = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'service-account.json'), 'utf8')
    );
    return {
      projectId: sa.project_id,
      clientEmail: sa.client_email,
      privateKey: sa.private_key,
    };
  } catch {
    return null;
  }
}

module.exports = { firebaseCredentials };
