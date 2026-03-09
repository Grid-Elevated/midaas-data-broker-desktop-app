import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  initAuth,
  login,
  logout,
  hasSession,
  getCurrentUser,
  getValidIdToken,
  refreshSession,
} from "../auth.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fakeJwt(payload, expInSeconds = 3600) {
  const p = { ...payload, exp: Math.floor(Date.now() / 1000) + expInSeconds };
  const header = btoa(JSON.stringify({ alg: "RS256" }));
  const body = btoa(JSON.stringify(p));
  return `${header}.${body}.fake-signature`;
}

function makeCognitoTokens(payload = {}, expInSeconds = 3600) {
  const defaultPayload = {
    sub: "user-123",
    "cognito:username": "testuser",
    email: "test@example.com",
    "cognito:groups": ["facility-abc"],
    ...payload,
  };
  return {
    IdToken: fakeJwt(defaultPayload, expInSeconds),
    AccessToken: fakeJwt({ sub: "user-123", token_use: "access" }, expInSeconds),
    RefreshToken: "fake-refresh-token",
    ExpiresIn: expInSeconds,
  };
}

function mockStorage(initial = {}) {
  const store = { ...initial };
  return {
    get: vi.fn(async (key) => store[key] ?? null),
    set: vi.fn(async (key, value) => {
      store[key] = value;
    }),
    _store: store,
  };
}

function cognitoOk(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

function cognitoFail(status, body) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  });
}

/* ------------------------------------------------------------------ */
/*  Global fetch mock                                                  */
/* ------------------------------------------------------------------ */

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(async () => {
  // Reset internal auth state by logging out with a no-op storage
  try {
    await logout();
  } catch {
    /* ignore */
  }
  globalThis.fetch = originalFetch;
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("getCurrentUser", () => {
  it("returns null when no token is stored", () => {
    expect(getCurrentUser()).toBeNull();
  });

  it("returns user info after a successful login", async () => {
    const tokens = makeCognitoTokens();
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: tokens })
    );
    const storage = mockStorage();
    await initAuth(storage);
    await login("testuser", "password");

    const user = getCurrentUser();
    expect(user).toEqual({
      username: "testuser",
      email: "test@example.com",
      facilityId: "facility-abc",
    });
  });

  it("returns empty facilityId when no cognito groups", async () => {
    const tokens = makeCognitoTokens({ "cognito:groups": undefined });
    // remove groups from the token payload
    const payloadNoGroups = {
      sub: "user-456",
      "cognito:username": "nogroup",
      email: "nogroup@example.com",
    };
    tokens.IdToken = fakeJwt(payloadNoGroups);
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: tokens })
    );
    const storage = mockStorage();
    await initAuth(storage);
    await login("nogroup", "password");

    const user = getCurrentUser();
    expect(user.facilityId).toBe("");
  });

  it("returns sub as username when cognito:username is missing", async () => {
    const payload = {
      sub: "sub-id-789",
      email: "sub@example.com",
      "cognito:groups": ["fac-1"],
    };
    const tokens = makeCognitoTokens();
    tokens.IdToken = fakeJwt(payload);
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: tokens })
    );
    const storage = mockStorage();
    await initAuth(storage);
    await login("someone", "password");

    const user = getCurrentUser();
    expect(user.username).toBe("sub-id-789");
  });
});

describe("hasSession", () => {
  it("returns false initially", () => {
    expect(hasSession()).toBe(false);
  });

  it("returns true after successful login", async () => {
    const tokens = makeCognitoTokens();
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: tokens })
    );
    const storage = mockStorage();
    await initAuth(storage);
    await login("testuser", "password");

    expect(hasSession()).toBe(true);
  });

  it("returns false after logout", async () => {
    const tokens = makeCognitoTokens();
    globalThis.fetch
      .mockReturnValueOnce(cognitoOk({ AuthenticationResult: tokens }))
      .mockReturnValueOnce(cognitoOk({})); // GlobalSignOut
    const storage = mockStorage();
    await initAuth(storage);
    await login("testuser", "password");
    await logout();

    expect(hasSession()).toBe(false);
  });
});

describe("login", () => {
  it("stores tokens and returns user info on success", async () => {
    const tokens = makeCognitoTokens();
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: tokens })
    );
    const storage = mockStorage();
    await initAuth(storage);
    const user = await login("testuser", "password");

    expect(user).toEqual({
      username: "testuser",
      email: "test@example.com",
      facilityId: "facility-abc",
    });
    expect(storage.set).toHaveBeenCalledWith(
      "auth_tokens",
      expect.objectContaining({
        idToken: tokens.IdToken,
        accessToken: tokens.AccessToken,
        refreshToken: tokens.RefreshToken,
      })
    );
  });

  it("throws on bad credentials (400 response)", async () => {
    globalThis.fetch.mockReturnValueOnce(
      cognitoFail(400, {
        __type: "com.amazonaws.cognito.identity.idp.model#NotAuthorizedException",
        message: "Incorrect username or password.",
      })
    );
    const storage = mockStorage();
    await initAuth(storage);

    await expect(login("bad", "creds")).rejects.toThrow(
      "Incorrect username or password."
    );
  });

  it("throws when no AuthenticationResult in response", async () => {
    globalThis.fetch.mockReturnValueOnce(cognitoOk({}));
    const storage = mockStorage();
    await initAuth(storage);

    await expect(login("testuser", "password")).rejects.toThrow(
      "Unexpected auth response"
    );
  });

  it("sends correct AuthFlow and ClientId in request body", async () => {
    const tokens = makeCognitoTokens();
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: tokens })
    );
    const storage = mockStorage();
    await initAuth(storage);
    await login("testuser", "password");

    const callBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(callBody.AuthFlow).toBe("USER_PASSWORD_AUTH");
    expect(callBody.ClientId).toBe("38er2dea2evgqfjrn4k3q4ehht");
    expect(callBody.AuthParameters.USERNAME).toBe("testuser");
    expect(callBody.AuthParameters.PASSWORD).toBe("password");
  });
});

describe("refreshSession", () => {
  it("refreshes tokens successfully", async () => {
    const tokens = makeCognitoTokens();
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: tokens })
    );
    const storage = mockStorage();
    await initAuth(storage);
    await login("testuser", "password");

    const newTokens = makeCognitoTokens(
      { "cognito:username": "testuser", email: "new@example.com" },
      7200
    );
    // Cognito refresh does not return RefreshToken
    const refreshResult = { ...newTokens };
    delete refreshResult.RefreshToken;
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: refreshResult })
    );

    await refreshSession();

    // The new id token should be stored, but refresh token should remain
    expect(storage.set).toHaveBeenLastCalledWith(
      "auth_tokens",
      expect.objectContaining({
        idToken: refreshResult.IdToken,
        accessToken: refreshResult.AccessToken,
        refreshToken: tokens.RefreshToken, // kept from original
      })
    );
  });

  it("throws when no refresh token is stored", async () => {
    const storage = mockStorage();
    await initAuth(storage);

    await expect(refreshSession()).rejects.toThrow("No refresh token");
  });

  it("throws when Cognito returns no AuthenticationResult on refresh", async () => {
    const tokens = makeCognitoTokens();
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: tokens })
    );
    const storage = mockStorage();
    await initAuth(storage);
    await login("testuser", "password");

    globalThis.fetch.mockReturnValueOnce(cognitoOk({}));
    await expect(refreshSession()).rejects.toThrow("Refresh failed");
  });

  it("sends REFRESH_TOKEN_AUTH flow", async () => {
    const tokens = makeCognitoTokens();
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: tokens })
    );
    const storage = mockStorage();
    await initAuth(storage);
    await login("testuser", "password");

    const refreshResult = { ...tokens };
    delete refreshResult.RefreshToken;
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: refreshResult })
    );
    await refreshSession();

    const lastCall = globalThis.fetch.mock.calls[1];
    const body = JSON.parse(lastCall[1].body);
    expect(body.AuthFlow).toBe("REFRESH_TOKEN_AUTH");
    expect(body.AuthParameters.REFRESH_TOKEN).toBe("fake-refresh-token");
  });
});

describe("getValidIdToken", () => {
  it("returns token when not expired", async () => {
    const tokens = makeCognitoTokens({}, 3600);
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: tokens })
    );
    const storage = mockStorage();
    await initAuth(storage);
    await login("testuser", "password");

    const token = await getValidIdToken();
    expect(token).toBe(tokens.IdToken);
  });

  it("auto-refreshes when token is expired", async () => {
    // Login with a token that expires very soon (already within the 60s buffer)
    const tokens = makeCognitoTokens({}, 30); // 30s — within the 60s early-expire buffer
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: tokens })
    );
    const storage = mockStorage();
    await initAuth(storage);
    await login("testuser", "password");

    // Set up refresh response with fresh tokens
    const freshTokens = makeCognitoTokens({}, 7200);
    delete freshTokens.RefreshToken;
    globalThis.fetch.mockReturnValueOnce(
      cognitoOk({ AuthenticationResult: freshTokens })
    );

    const token = await getValidIdToken();
    expect(token).toBe(freshTokens.IdToken);
    // fetch was called twice: once for login, once for refresh
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("throws when not authenticated", async () => {
    const storage = mockStorage();
    await initAuth(storage);

    await expect(getValidIdToken()).rejects.toThrow("Not authenticated");
  });
});

describe("logout", () => {
  it("clears tokens and hasSession becomes false", async () => {
    const tokens = makeCognitoTokens();
    globalThis.fetch
      .mockReturnValueOnce(cognitoOk({ AuthenticationResult: tokens }))
      .mockReturnValueOnce(cognitoOk({})); // GlobalSignOut
    const storage = mockStorage();
    await initAuth(storage);
    await login("testuser", "password");

    expect(hasSession()).toBe(true);
    await logout();
    expect(hasSession()).toBe(false);
    expect(getCurrentUser()).toBeNull();
  });

  it("clears tokens in storage", async () => {
    const tokens = makeCognitoTokens();
    globalThis.fetch
      .mockReturnValueOnce(cognitoOk({ AuthenticationResult: tokens }))
      .mockReturnValueOnce(cognitoOk({}));
    const storage = mockStorage();
    await initAuth(storage);
    await login("testuser", "password");
    await logout();

    expect(storage.set).toHaveBeenLastCalledWith("auth_tokens", null);
  });

  it("handles missing access token gracefully (no GlobalSignOut call)", async () => {
    // initAuth with a stored session that has no accessToken
    const storage = mockStorage({
      auth_tokens: {
        idToken: null,
        accessToken: null,
        refreshToken: "some-refresh",
        expiresAt: 0,
      },
    });
    await initAuth(storage);
    // logout should not throw even without access token
    await expect(logout()).resolves.toBeUndefined();
    expect(hasSession()).toBe(false);
  });

  it("handles GlobalSignOut failure gracefully", async () => {
    const tokens = makeCognitoTokens();
    globalThis.fetch
      .mockReturnValueOnce(cognitoOk({ AuthenticationResult: tokens }))
      .mockReturnValueOnce(
        cognitoFail(400, {
          __type: "NotAuthorizedException",
          message: "Token expired",
        })
      );
    const storage = mockStorage();
    await initAuth(storage);
    await login("testuser", "password");

    // Should not throw even if GlobalSignOut fails
    await expect(logout()).resolves.toBeUndefined();
    expect(hasSession()).toBe(false);
  });
});

describe("initAuth", () => {
  it("returns false when no stored session", async () => {
    const storage = mockStorage();
    const result = await initAuth(storage);
    expect(result).toBe(false);
  });

  it("returns true when stored session with refresh token exists", async () => {
    const storage = mockStorage({
      auth_tokens: {
        idToken: fakeJwt({ sub: "user-1", "cognito:username": "stored" }),
        accessToken: fakeJwt({ sub: "user-1", token_use: "access" }),
        refreshToken: "stored-refresh-token",
        expiresAt: Date.now() + 3600000,
      },
    });
    const result = await initAuth(storage);
    expect(result).toBe(true);
    expect(hasSession()).toBe(true);
  });

  it("returns false when stored session has no refresh token", async () => {
    const storage = mockStorage({
      auth_tokens: {
        idToken: fakeJwt({ sub: "user-1" }),
        accessToken: fakeJwt({ sub: "user-1" }),
        refreshToken: null,
        expiresAt: Date.now() + 3600000,
      },
    });
    const result = await initAuth(storage);
    expect(result).toBe(false);
  });

  it("restores user info from stored session", async () => {
    const idToken = fakeJwt({
      sub: "user-stored",
      "cognito:username": "storeduser",
      email: "stored@example.com",
      "cognito:groups": ["stored-facility"],
    });
    const storage = mockStorage({
      auth_tokens: {
        idToken,
        accessToken: fakeJwt({ sub: "user-stored" }),
        refreshToken: "stored-refresh",
        expiresAt: Date.now() + 3600000,
      },
    });
    await initAuth(storage);

    const user = getCurrentUser();
    expect(user).toEqual({
      username: "storeduser",
      email: "stored@example.com",
      facilityId: "stored-facility",
    });
  });

  it("calls storage.get with auth_tokens key", async () => {
    const storage = mockStorage();
    await initAuth(storage);
    expect(storage.get).toHaveBeenCalledWith("auth_tokens");
  });
});
