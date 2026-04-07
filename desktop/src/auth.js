/* ------------------------------------------------------------------ */
/*  Cognito Auth — USER_PASSWORD_AUTH + REFRESH_TOKEN_AUTH             */
/* ------------------------------------------------------------------ */

const REGION = "us-east-1";
const USER_POOL_ID = "us-east-1_4q4Mvew6O";
const CLIENT_ID = "38er2dea2evgqfjrn4k3q4ehht";
const COGNITO_URL = `https://cognito-idp.${REGION}.amazonaws.com/`;

/* ---- token cache (in-memory) ---- */
let _tokens = { idToken: null, accessToken: null, refreshToken: null, expiresAt: 0 };

/* ---- storage ref (set from App via init) ---- */
let _storage = null;

/* ---- background refresh ---- */
let _refreshInterval = null;
const REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 minutes (access tokens expire in 60)

/* ---- helpers ---- */

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

function isTokenExpired(token) {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return true;
  // treat as expired 60s early to avoid race conditions
  return Date.now() >= (payload.exp - 60) * 1000;
}

async function cognitoRequest(action, payload) {
  const res = await fetch(COGNITO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json();

  if (!res.ok) {
    const code = body.__type?.split("#").pop() || "AuthError";
    const message = body.message || body.Message || "Authentication failed";
    const err = new Error(message);
    err.code = code;
    throw err;
  }
  return body;
}

/* ---- public API ---- */

/** Call once at startup — pass in the storage abstraction from App */
export async function initAuth(storage) {
  _storage = storage;
  const saved = await _storage.get("auth_tokens");
  if (saved?.refreshToken) {
    _tokens = { ..._tokens, ...saved };
    return true; // has stored session
  }
  return false; // needs login
}

/** Sign in with username + password. Returns user info. */
export async function login(username, password) {
  const data = await cognitoRequest("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: CLIENT_ID,
    AuthParameters: {
      USERNAME: username,
      PASSWORD: password,
    },
  });

  const result = data.AuthenticationResult;
  if (!result) throw new Error("Unexpected auth response — no tokens returned");

  _tokens = {
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken,
    expiresAt: Date.now() + result.ExpiresIn * 1000,
  };

  if (_storage) await _storage.set("auth_tokens", _tokens);

  const payload = decodeJwtPayload(result.IdToken);
  const groups = payload?.["cognito:groups"] || [];
  return {
    username: payload?.["cognito:username"] || payload?.sub || username,
    email: payload?.email || "",
    facilityId: groups[0] || "",
  };
}

/** Silently refresh tokens using stored refresh token. */
export async function refreshSession() {
  if (!_tokens.refreshToken) throw new Error("No refresh token — please sign in");

  const data = await cognitoRequest("InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: CLIENT_ID,
    AuthParameters: {
      REFRESH_TOKEN: _tokens.refreshToken,
    },
  });

  const result = data.AuthenticationResult;
  if (!result) throw new Error("Refresh failed — no tokens returned");

  // Cognito does NOT return a new refresh token on refresh — keep the old one
  _tokens = {
    ..._tokens,
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    expiresAt: Date.now() + result.ExpiresIn * 1000,
  };

  if (_storage) await _storage.set("auth_tokens", _tokens);
}

/**
 * Get a valid ID token — auto-refreshes if expired.
 * This is the main function to call before every upload.
 */
export async function getValidIdToken() {
  if (!_tokens.idToken || !_tokens.refreshToken) {
    throw new Error("Not authenticated — please sign in");
  }

  if (isTokenExpired(_tokens.idToken)) {
    console.log("[auth] Token expired, refreshing…");
    await refreshSession();
  }

  return _tokens.idToken;
}

/** Sign out — clear everything */
export async function logout() {
  // Optionally revoke on Cognito side (best-effort)
  if (_tokens.accessToken) {
    try {
      await cognitoRequest("GlobalSignOut", { AccessToken: _tokens.accessToken });
    } catch { /* ignore — local sign-out still works */ }
  }

  _tokens = { idToken: null, accessToken: null, refreshToken: null, expiresAt: 0 };
  if (_storage) await _storage.set("auth_tokens", null);
}

/** Quick check — do we have a stored session? */
export function hasSession() {
  return !!_tokens.refreshToken;
}

/** Get user info from cached token (no network call) */
export function getCurrentUser() {
  if (!_tokens.idToken) return null;
  const payload = decodeJwtPayload(_tokens.idToken);
  if (!payload) return null;
  const groups = payload["cognito:groups"] || [];
  const ROLE_GROUPS = new Set(["global_admin", "admin", "heber_demo"]);
  const facilityId =
    groups.find((g) => !ROLE_GROUPS.has(g) && !g.endsWith("_admin")) ||
    (groups.includes("global_admin") ? "global_admin" : "") ||
    (groups[0]?.replace(/_admin$/, "") ?? "");
  return {
    username: payload["cognito:username"] || payload.sub || "",
    email: payload.email || "",
    facilityId,
  };
}

/**
 * Start a background interval that silently refreshes the access token
 * every 50 minutes. Also handles wake-from-sleep via visibilitychange.
 */
export function startBackgroundRefresh() {
  stopBackgroundRefresh();

  const doRefresh = async () => {
    if (!_tokens.refreshToken) return;
    try {
      if (isTokenExpired(_tokens.idToken)) {
        console.log("[auth] Background refresh — token expired, refreshing…");
        await refreshSession();
      }
    } catch (err) {
      console.warn("[auth] Background refresh failed:", err.message);
      // If refresh token itself is dead, try stored credentials
      await tryReloginFromStoredCredentials();
    }
  };

  // Interval for normal operation
  _refreshInterval = setInterval(doRefresh, REFRESH_INTERVAL_MS);

  // Wake-from-sleep / tab-focus handler — fires immediately on resume
  document.addEventListener("visibilitychange", _onVisibilityChange);
  window.addEventListener("focus", _onWindowFocus);
}

export function stopBackgroundRefresh() {
  if (_refreshInterval) {
    clearInterval(_refreshInterval);
    _refreshInterval = null;
  }
  document.removeEventListener("visibilitychange", _onVisibilityChange);
  window.removeEventListener("focus", _onWindowFocus);
}

async function _onVisibilityChange() {
  if (document.visibilityState === "visible" && _tokens.refreshToken) {
    await _silentRefresh();
  }
}

async function _onWindowFocus() {
  if (_tokens.refreshToken) {
    await _silentRefresh();
  }
}

async function _silentRefresh() {
  try {
    if (isTokenExpired(_tokens.idToken)) {
      console.log("[auth] Visibility/focus refresh…");
      await refreshSession();
    }
  } catch (err) {
    console.warn("[auth] Focus refresh failed:", err.message);
    await tryReloginFromStoredCredentials();
  }
}

/** Store credentials so we can silently re-login when the refresh token expires */
export async function storeCredentials(username, password) {
  if (_storage) await _storage.set("auth_creds", { username, password });
}

/** Clear stored credentials (on explicit logout) */
export async function clearCredentials() {
  if (_storage) await _storage.set("auth_creds", null);
}

/** Attempt silent re-login using stored credentials */
export async function tryReloginFromStoredCredentials() {
  if (!_storage) return false;
  const creds = await _storage.get("auth_creds");
  if (!creds?.username || !creds?.password) {
    console.warn("[auth] No stored credentials — user must re-login manually");
    return false;
  }
  try {
    console.log("[auth] Refresh token expired — re-authenticating with stored credentials…");
    await login(creds.username, creds.password);
    console.log("[auth] Silent re-login successful");
    return true;
  } catch (err) {
    console.error("[auth] Silent re-login failed:", err.message);
    return false;
  }
}
