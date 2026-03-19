export default function LoginScreen({ loginForm, setLoginForm, handleLogin, authLoading, authError }) {
  return (
    <div className="app login-screen">
      <header className="hero">
        <div className="logo-row">
          <img src="/Grid_logo_mark.png" alt="Grid logo" className="logo-img" />
          <span className="logo-text">MIDAAS</span>
        </div>
        <p className="subhead">Sign in with your MIDAAS account to start uploading.</p>
      </header>

      <form className="login-card" onSubmit={handleLogin}>
        <label className="login-field">
          <span className="login-label">Username or Email</span>
          <input
            type="text"
            className="login-input"
            value={loginForm.username}
            onChange={(e) => setLoginForm((f) => ({ ...f, username: e.target.value }))}
            autoFocus
            required
            disabled={authLoading}
          />
        </label>
        <label className="login-field">
          <span className="login-label">Password</span>
          <input
            type="password"
            className="login-input"
            value={loginForm.password}
            onChange={(e) => setLoginForm((f) => ({ ...f, password: e.target.value }))}
            required
            disabled={authLoading}
          />
        </label>
        {authError && <div className="login-error">{authError}</div>}
        <button type="submit" className="primary login-btn" disabled={authLoading}>
          {authLoading ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </div>
  );
}
