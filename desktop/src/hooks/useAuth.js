import { useState, useCallback } from "react";
import { initAuth, login, logout, getValidIdToken, getCurrentUser, startBackgroundRefresh, stopBackgroundRefresh, storeCredentials, clearCredentials } from "../auth";
import { storage } from "../constants";

export function useAuth() {
  const [authed, setAuthed] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });

  const initializeAuth = useCallback(async () => {
    const hadSession = await initAuth(storage);
    if (hadSession) {
      try {
        await getValidIdToken();
        setAuthed(true);
        setAuthUser(getCurrentUser());
        startBackgroundRefresh();
      } catch {
        setAuthed(false);
      }
    }
    setAuthLoading(false);
  }, []);

  const handleLogin = useCallback(async (e) => {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);
    try {
      const user = await login(loginForm.username, loginForm.password);
      await storeCredentials(loginForm.username, loginForm.password);
      startBackgroundRefresh();
      setAuthed(true);
      setAuthUser(user);
      setLoginForm({ username: "", password: "" });
    } catch (err) {
      setAuthError(err.message || "Login failed");
    } finally {
      setAuthLoading(false);
    }
  }, [loginForm]);

  const handleLogout = useCallback(async (entries, stopOne) => {
    entries.forEach((e) => { if (e.running) stopOne(e.id); });
    stopBackgroundRefresh();
    await clearCredentials();
    await logout();
    setAuthed(false);
    setAuthUser(null);
  }, []);

  return {
    authed, authUser, authLoading, authError,
    loginForm, setLoginForm,
    initializeAuth, handleLogin, handleLogout,
  };
}
