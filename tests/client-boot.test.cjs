const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

// Browser ESM, loaded without changing this CommonJS server's package mode.
const moduleReady = readFile(join(__dirname, '../js/client-boot.js'), 'utf8')
  .then((source) => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function options(overrides = {}) {
  return {
    loadAuth: async () => ({ initAuth: () => ({ app: {} }) }),
    loadFriends: async () => ({ initFriends: () => ({}) }),
    authCallbacks: {}, friendsOptions: {},
    onAuthReady() {}, onFriendsReady() {}, onOffline() {},
    ...overrides,
  };
}

test('config request starts immediately, while local setup can continue', async () => {
  const { loadClientConfig } = await moduleReady;
  const response = deferred();
  let started = false;
  const pending = loadClientConfig(() => { started = true; return response.promise; });
  assert.equal(started, true);
  response.resolve({ json: async () => ({ offline: true }) });
  assert.deepEqual(await pending, { offline: true });
});

test('config network, JSON and synchronous failures retain online fallback', async () => {
  const { loadClientConfig } = await moduleReady;
  for (const fetchConfig of [
    () => Promise.reject(new Error('network')),
    () => ({ json: async () => { throw new Error('invalid JSON'); } }),
    () => { throw new Error('fetch unavailable'); },
  ]) assert.deepEqual(await loadClientConfig(fetchConfig), {});
});

test('offline mode never starts either Firebase module download', async () => {
  const { startClientServices } = await moduleReady;
  let offline = 0;
  const services = startClientServices({ offline: true }, options({
    loadAuth: () => assert.fail('offline auth import'),
    loadFriends: () => assert.fail('offline friends import'),
    onOffline: () => offline++,
  }));
  assert.equal(offline, 1);
  assert.equal(await services.authReady, null);
  assert.equal(await services.friendsReady, null);
});

test('online imports overlap and auth initializes while friends is still loading', async () => {
  const { startClientServices } = await moduleReady;
  const auth = deferred(), friends = deferred();
  const calls = [];
  const firebaseApp = {};
  const services = startClientServices({}, options({
    loadAuth: () => { calls.push('load-auth'); return auth.promise; },
    loadFriends: () => { calls.push('load-friends'); return friends.promise; },
    onAuthReady: () => calls.push('auth-ready'),
    onFriendsReady: () => calls.push('friends-ready'),
  }));
  await Promise.resolve();
  assert.deepEqual(calls, ['load-auth', 'load-friends']);
  auth.resolve({ initAuth: () => ({ app: firebaseApp }) });
  await services.authReady;
  assert.deepEqual(calls, ['load-auth', 'load-friends', 'auth-ready']);
  friends.resolve({ initFriends: ({ app }) => { assert.equal(app, firebaseApp); return {}; } });
  await services.friendsReady;
  assert.equal(calls.at(-1), 'friends-ready');
});

test('friends arriving first waits for shared Firebase app initialization', async () => {
  const { startClientServices } = await moduleReady;
  const auth = deferred();
  let friendsInitialized = false;
  const services = startClientServices({}, options({
    loadAuth: () => auth.promise,
    loadFriends: async () => ({ initFriends: () => { friendsInitialized = true; return {}; } }),
  }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(friendsInitialized, false);
  auth.resolve({ initAuth: () => ({ app: {} }) });
  await services.friendsReady;
  assert.equal(friendsInitialized, true);
});

test('friends download failure does not reject or prevent authentication', async () => {
  const { startClientServices } = await moduleReady;
  let authenticated = false;
  const services = startClientServices({}, options({
    loadFriends: async () => { throw new Error('social unavailable'); },
    onAuthReady: () => { authenticated = true; },
  }));
  const rejection = assert.rejects(services.friendsReady, /social unavailable/);
  await services.authReady;
  await rejection;
  assert.equal(authenticated, true);
});

test('auth failure never initializes friends or fabricates a successful login', async () => {
  const { startClientServices } = await moduleReady;
  const services = startClientServices({}, options({
    loadAuth: () => { throw new Error('auth unavailable'); },
    loadFriends: async () => ({ initFriends: () => assert.fail('no Firebase app') }),
    onAuthReady: () => assert.fail('auth did not succeed'),
  }));
  await Promise.all([
    assert.rejects(services.authReady, /auth unavailable/),
    assert.rejects(services.friendsReady, /auth unavailable/),
  ]);
});

test('late friends initialization catches up current signed-in account exactly once', async () => {
  const { createFriendsLifecycle } = await moduleReady;
  const user = { uid: 'test-user' };
  const calls = [];
  const lifecycle = createFriendsLifecycle(() => user);
  lifecycle.sync(); // auth callback can finish before the optional module
  lifecycle.attach({ onSignIn: (u) => calls.push(u), onSignOut: () => calls.push(null) });
  lifecycle.sync(); // an in-flight auth callback must not duplicate listeners
  assert.deepEqual(calls, [user]);
});

test('sign-out while friends loads cannot revive the former account', async () => {
  const { createFriendsLifecycle } = await moduleReady;
  let user = { uid: 'former-user' };
  const calls = [];
  const lifecycle = createFriendsLifecycle(() => user);
  lifecycle.sync();
  user = null;
  lifecycle.sync();
  lifecycle.attach({ onSignIn: (u) => calls.push(u), onSignOut: () => calls.push(null) });
  assert.deepEqual(calls, [null]);
});

test('account switch during friends loading initializes only the latest account', async () => {
  const { createFriendsLifecycle } = await moduleReady;
  let user = { uid: 'first-user' };
  const calls = [];
  const lifecycle = createFriendsLifecycle(() => user);
  lifecycle.sync();
  user = { uid: 'second-user' };
  lifecycle.attach({ onSignIn: (u) => calls.push(u), onSignOut: () => calls.push(null) });
  assert.deepEqual(calls, [user]);
  user = null;
  lifecycle.sync();
  assert.equal(calls.at(-1), null);
});

test('callbacks and friends game options retain their original identities', async () => {
  const { startClientServices } = await moduleReady;
  const authCallbacks = { onAuthed() {}, onSignedOut() {} };
  const friendsOptions = { send() {}, canPlay() {}, getGameContext() {} };
  const services = startClientServices({}, options({
    authCallbacks, friendsOptions,
    loadAuth: async () => ({ initAuth: (callbacks) => {
      assert.equal(callbacks, authCallbacks);
      return { app: 'shared-app' };
    } }),
    loadFriends: async () => ({ initFriends: (received) => {
      assert.deepEqual(received, { ...friendsOptions, app: 'shared-app' });
      return {};
    } }),
  }));
  await services.friendsReady;
});
