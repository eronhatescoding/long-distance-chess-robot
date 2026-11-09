// Keep optional social features out of the tap-login critical path. This
// module has no Firebase imports: an offline kiosk must never request them.
export function loadClientConfig(fetchConfig) {
  try {
    return Promise.resolve(fetchConfig())
      .then((response) => response.json())
      .catch(() => ({}));
  } catch {
    return Promise.resolve({});
  }
}

// Catch up a module that loads after sign-in, using the current account only.
// Repeated synchronization for the same Firebase User must not restart its
// Firestore listeners. A sign-out during loading must not revive that user.
export function createFriendsLifecycle(getCurrentUser) {
  let api = null;
  let syncedUser;
  function sync() {
    const user = getCurrentUser();
    if (!api || user === syncedUser) return;
    syncedUser = user;
    if (user) api.onSignIn(user);
    else api.onSignOut();
  }
  return {
    sync,
    attach(nextApi) {
      api = nextApi;
      syncedUser = undefined;
      sync();
    },
  };
}

export function startClientServices(config, {
  loadAuth,
  loadFriends,
  authCallbacks,
  friendsOptions,
  onAuthReady,
  onFriendsReady,
  onOffline,
}) {
  if (config.offline) {
    onOffline();
    return { authReady: Promise.resolve(null), friendsReady: Promise.resolve(null) };
  }

  // Start both downloads together, but never await Firestore before starting
  // /redeem and Firebase Authentication. Friends still initializes only after
  // initAuth has created the shared Firebase app.
  const authModule = Promise.resolve().then(loadAuth);
  const friendsModule = Promise.resolve().then(loadFriends);
  const authReady = authModule.then(({ initAuth }) => {
    const api = initAuth(authCallbacks);
    onAuthReady(api);
    return api;
  });
  const friendsReady = Promise.all([authReady, friendsModule]).then(([authApi, { initFriends }]) => {
    const api = initFriends({ ...friendsOptions, app: authApi.app });
    onFriendsReady(api);
    return api;
  });
  return { authReady, friendsReady };
}
