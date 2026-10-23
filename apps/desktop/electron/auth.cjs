const { shell } = require('electron');

/**
 * Logto OIDC login through the user's system browser. The main window never
 * moves; instead the flow is:
 *
 *   /auth/begin (JSON { authorizeUrl, state })
 *     → shell.openExternal(authorizeUrl)   (system browser, reuse existing SSO)
 *     → Logto → /auth/callback             (Core exchanges code, records state→session)
 *     → poll /auth/check?state=…  until complete
 *     → /auth/me with X-Tinadec-Session
 *
 * The session token stays in this main process and is never handed to the
 * renderer — the renderer only receives the resolved identity over IPC.
 */

let sessionToken = null;
let identity = null;
let activeLogin = null;

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function gatewayUrl() {
  return process.env.TINADEC_RESOLVED_GATEWAY_URL ?? process.env.TINADEC_GATEWAY_URL ?? 'http://127.0.0.1:48730';
}

function currentIdentity() {
  return identity ? { sub: identity.sub, nickname: identity.nickname, avatar_url: identity.avatar_url, email: identity.email } : null;
}

function getAuthState() {
  const me = currentIdentity();
  return me ? { loggedIn: true, ...me } : { loggedIn: false };
}

/**
 * Start (or rejoin) a login and resolve with the identity on success, or null
 * when the user cancels, the callback never arrives, or identity resolution
 * fails. A second click while a login is in flight shares the same promise.
 */
function openLogin() {
  if (identity) return Promise.resolve(currentIdentity());
  if (activeLogin) return activeLogin;

  activeLogin = (async () => {
    try {
      const beginRes = await fetch(`${gatewayUrl()}/auth/begin`);
      if (!beginRes.ok) throw new Error(`/auth/begin -> ${beginRes.status}`);
      const begin = await beginRes.json();
      const state = String(begin.state ?? '');
      const authorizeUrl = String(begin.authorize_url ?? '');
      if (!state || !authorizeUrl) throw new Error('/auth/begin returned no state or authorizeUrl');

      await shell.openExternal(authorizeUrl);

      const token = await pollForSession(state);
      if (!token) return null;

      sessionToken = token;
      const meRes = await fetch(`${gatewayUrl()}/auth/me`, { headers: { 'x-tinadec-session': token } });
      if (!meRes.ok) throw new Error(`/auth/me -> ${meRes.status}`);
      const me = await meRes.json();
      identity = {
        sub: String(me.subject ?? ''),
        nickname: String(me.nickname ?? ''),
        avatar_url: typeof me.avatar_url === 'string' ? me.avatar_url : null,
        email: typeof me.email === 'string' ? me.email : null,
      };
      return currentIdentity();
    } catch (error) {
      console.error('[auth] login failed:', error.message);
      sessionToken = null;
      return null;
    } finally {
      activeLogin = null;
    }
  })();

  return activeLogin;
}

/** Poll the login result until it completes or the timeout elapses. */
function pollForSession(state) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const res = await fetch(`${gatewayUrl()}/auth/check?state=${encodeURIComponent(state)}`);
        if (res.ok) {
          const body = await res.json();
          if (body.status === 'complete' && typeof body.session === 'string') {
            resolve(body.session);
            return;
          }
        }
      } catch (error) {
        // Transient network/startup hiccup; keep polling until the deadline.
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
  });
}

/**
 * Write the signed-in user's nickname / avatar through to Logto's Account API,
 * then adopt the profile Logto reports back. Cancelling the confirm dialog in the
 * renderer simply never calls this.
 */
async function updateProfile({ nickname, avatarUrl } = {}) {
  if (!sessionToken) throw new Error('updateProfile requires an active login session');
  const body = {};
  if (typeof nickname === 'string' && nickname.trim()) body.nickname = nickname.trim();
  if (typeof avatarUrl === 'string') body.avatar_url = avatarUrl.trim();

  const res = await fetch(`${gatewayUrl()}/auth/profile`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-tinadec-session': sessionToken },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`/auth/profile -> ${res.status}: ${detail}`);
  }
  const me = await res.json();
  identity = {
    sub: String(me.subject ?? ''),
    nickname: String(me.nickname ?? ''),
    avatar_url: typeof me.avatar_url === 'string' ? me.avatar_url : null,
    email: typeof me.email === 'string' ? me.email : null,
  };
  return currentIdentity();
}

async function logout() {
  const token = sessionToken;
  sessionToken = null;
  identity = null;
  if (token) {
    try {
      await fetch(`${gatewayUrl()}/auth/logout`, { method: 'POST', headers: { 'x-tinadec-session': token } });
    } catch (error) {
      console.warn('[auth] logout revoke failed:', error.message);
    }
  }
  return { loggedIn: false };
}

module.exports = {
  openLogin,
  logout,
  getAuthState,
  updateProfile,
};