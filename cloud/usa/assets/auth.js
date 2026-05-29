/* auth.js — Firebase Auth wrapper for HerAI Screener.
 *
 * Provides:
 *   window.HeraiAuth.currentUser   — null or {uid, name, email, photo, provider}
 *   window.HeraiAuth.requireAuth() — returns Promise<user>; shows login modal if needed
 *   window.HeraiAuth.showLogin()   — opens the login/signup modal
 *   window.HeraiAuth.logout()      — signs out
 *   window.HeraiAuth.onAuthChange(fn) — register callback for auth state changes
 *
 * Firebase config comes from a <script> block in the page that sets
 *   window.FIREBASE_CONFIG = { apiKey, authDomain, … }
 * If FIREBASE_CONFIG is missing, auth is disabled (dev mode).
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let _user = null;            // null or {uid, name, email, photo, provider}
  let _fbAuth = null;          // firebase.auth() instance
  let _listeners = [];         // auth-change callbacks
  let _pendingResolve = null;  // resolve() from requireAuth()

  // ── Public API ─────────────────────────────────────────────────────────────
  const Auth = window.HeraiAuth = {
    get currentUser() { return _user; },
    requireAuth,
    showLogin,
    logout,
    onAuthChange(fn) { _listeners.push(fn); },
    getIdToken,
  };

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    _injectModal();
    _initFirebase();
    _renderAuthUI();
  });

  // ── Firebase init ──────────────────────────────────────────────────────────
  function _initFirebase() {
    const cfg = window.FIREBASE_CONFIG;
    if (!cfg || !cfg.apiKey) {
      console.warn('[auth] FIREBASE_CONFIG not set — auth disabled (dev mode)');
      return;
    }
    if (typeof firebase === 'undefined') {
      console.warn('[auth] Firebase SDK not loaded');
      return;
    }
    firebase.initializeApp(cfg);
    _fbAuth = firebase.auth();
    _fbAuth.onAuthStateChanged(user => {
      if (user) {
        _user = {
          uid: user.uid,
          name: user.displayName || user.email.split('@')[0],
          email: user.email,
          photo: user.photoURL,
          provider: user.providerData[0]?.providerId || 'password',
        };
      } else {
        _user = null;
      }
      // Persist user info to localStorage for cross-page badge
      if (_user) {
        localStorage.setItem('herai_user', JSON.stringify({
          name: _user.name, photo: _user.photo, email: _user.email
        }));
      } else {
        localStorage.removeItem('herai_user');
      }
      _renderAuthUI();
      _listeners.forEach(fn => { try { fn(_user); } catch(e) { console.error(e); } });
      // Resolve pending requireAuth promise
      if (_user && _pendingResolve) {
        _pendingResolve(_user);
        _pendingResolve = null;
        _hideModal();
      }
    });
  }

  // ── requireAuth ────────────────────────────────────────────────────────────
  // AUTH_ENABLED: set to true once Firebase is configured to enforce login.
  // When false, all actions are allowed without sign-in.
  const AUTH_ENABLED = false;

  function requireAuth() {
    if (!AUTH_ENABLED) return Promise.resolve({uid:'anon',name:'Guest',email:''});
    if (_user) return Promise.resolve(_user);
    return new Promise(resolve => {
      _pendingResolve = resolve;
      showLogin();
    });
  }

  // ── getIdToken ─────────────────────────────────────────────────────────────
  async function getIdToken() {
    if (!_fbAuth || !_fbAuth.currentUser) return null;
    return _fbAuth.currentUser.getIdToken();
  }

  // ── logout ─────────────────────────────────────────────────────────────────
  function logout() {
    if (_fbAuth) _fbAuth.signOut();
    _user = null;
    localStorage.removeItem('herai_user');
    _renderAuthUI();
  }

  // ── Login Modal ────────────────────────────────────────────────────────────
  function _injectModal() {
    if (document.getElementById('authModal')) return;
    const div = document.createElement('div');
    div.innerHTML = `
<div class="auth-overlay" id="authModal" hidden>
  <div class="auth-modal">
    <button class="auth-close" id="authClose">&times;</button>
    <div class="auth-header">
      <h2>Welcome to Elite Club</h2>
      <p class="muted small">Sign in to post, vote, and participate</p>
    </div>

    <!-- Social login buttons -->
    <div class="auth-social">
      <button class="auth-btn auth-google" id="authGoogle">
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
        Continue with Google
      </button>
      <button class="auth-btn auth-facebook" id="authFacebook">
        <svg viewBox="0 0 24 24" width="20" height="20"><path d="M24 12.07C24 5.41 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.8-4.7 4.54-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.95.93-1.95 1.89v2.26h3.33l-.53 3.5h-2.8V24C19.61 23.1 24 18.1 24 12.07z" fill="#1877F2"/></svg>
        Continue with Facebook
      </button>
    </div>

    <div class="auth-divider"><span>or</span></div>

    <!-- Tab: Login / Sign Up -->
    <div class="auth-tabs">
      <button class="auth-tab active" data-tab="login">Log In</button>
      <button class="auth-tab" data-tab="signup">Sign Up</button>
    </div>

    <!-- Login form -->
    <form class="auth-form" id="authLoginForm">
      <input type="email" id="authLoginEmail" placeholder="Email" required autocomplete="email">
      <input type="password" id="authLoginPass" placeholder="Password" required autocomplete="current-password">
      <button type="submit" class="auth-submit">Log In</button>
      <a href="#" class="auth-forgot" id="authForgot">Forgot password?</a>
      <div class="auth-error" id="authLoginError" hidden></div>
      <div class="auth-success" id="authLoginSuccess" hidden></div>
    </form>

    <!-- Sign Up form -->
    <form class="auth-form" id="authSignupForm" hidden>
      <input type="text" id="authSignupName" placeholder="Full name" required autocomplete="name">
      <input type="email" id="authSignupEmail" placeholder="Email" required autocomplete="email">
      <input type="password" id="authSignupPass" placeholder="Password (min 6 characters)" required minlength="6" autocomplete="new-password">
      <input type="password" id="authSignupPass2" placeholder="Confirm password" required minlength="6" autocomplete="new-password">
      <button type="submit" class="auth-submit">Create Account</button>
      <div class="auth-error" id="authSignupError" hidden></div>
    </form>
  </div>
</div>`;
    document.body.appendChild(div);
    _bindModalEvents();
  }

  function _bindModalEvents() {
    const modal = document.getElementById('authModal');

    // Close
    document.getElementById('authClose').addEventListener('click', _hideModal);
    modal.addEventListener('click', e => { if (e.target === modal) _hideModal(); });

    // Tabs
    modal.querySelectorAll('.auth-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        modal.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        _showForm(tab.dataset.tab);
      });
    });

    // Forgot password link — sends reset email using login email field
    document.getElementById('authForgot').addEventListener('click', e => {
      e.preventDefault();
      if (!_fbAuth) return _showDevMsg();
      const email = document.getElementById('authLoginEmail').value.trim();
      if (!email) {
        _showError('authLoginError', 'Enter your email above, then click Forgot password.');
        return;
      }
      _clearErrors();
      _fbAuth.sendPasswordResetEmail(email).then(() => {
        const el = document.getElementById('authLoginSuccess');
        el.textContent = 'Reset link sent to ' + email + '. Check your inbox.';
        el.hidden = false;
      }).catch(e => _showError('authLoginError', _friendlyError(e)));
    });

    // Google login
    document.getElementById('authGoogle').addEventListener('click', () => {
      if (!_fbAuth) return _showDevMsg();
      const provider = new firebase.auth.GoogleAuthProvider();
      _fbAuth.signInWithPopup(provider).catch(e => _showError('authLoginError', _friendlyError(e)));
    });

    // Facebook login
    document.getElementById('authFacebook').addEventListener('click', () => {
      if (!_fbAuth) return _showDevMsg();
      const provider = new firebase.auth.FacebookAuthProvider();
      _fbAuth.signInWithPopup(provider).catch(e => _showError('authLoginError', _friendlyError(e)));
    });

    // Login form
    document.getElementById('authLoginForm').addEventListener('submit', e => {
      e.preventDefault();
      if (!_fbAuth) return _showDevMsg();
      const email = document.getElementById('authLoginEmail').value.trim();
      const pass = document.getElementById('authLoginPass').value;
      _clearErrors();
      _fbAuth.signInWithEmailAndPassword(email, pass)
        .catch(e => _showError('authLoginError', _friendlyError(e)));
    });

    // Signup form
    document.getElementById('authSignupForm').addEventListener('submit', e => {
      e.preventDefault();
      if (!_fbAuth) return _showDevMsg();
      const name = document.getElementById('authSignupName').value.trim();
      const email = document.getElementById('authSignupEmail').value.trim();
      const pass = document.getElementById('authSignupPass').value;
      const pass2 = document.getElementById('authSignupPass2').value;
      _clearErrors();
      if (pass !== pass2) {
        _showError('authSignupError', 'Passwords do not match.');
        return;
      }
      _fbAuth.createUserWithEmailAndPassword(email, pass)
        .then(cred => cred.user.updateProfile({ displayName: name }))
        .then(() => {
          // Refresh user state with display name
          _user.name = document.getElementById('authSignupName').value.trim();
          _renderAuthUI();
        })
        .catch(e => _showError('authSignupError', _friendlyError(e)));
    });
  }

  function _showForm(tab) {
    document.getElementById('authLoginForm').hidden = tab !== 'login';
    document.getElementById('authSignupForm').hidden = tab !== 'signup';
    _clearErrors();
  }

  function showLogin() {
    const modal = document.getElementById('authModal');
    if (modal) { modal.hidden = false; _showForm('login'); }
  }

  function _hideModal() {
    const modal = document.getElementById('authModal');
    if (modal) modal.hidden = true;
    if (_pendingResolve) { _pendingResolve = null; } // cancelled
  }

  function _showError(id, msg) {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; el.hidden = false; }
  }
  function _clearErrors() {
    document.querySelectorAll('.auth-error, .auth-success').forEach(el => el.hidden = true);
  }

  function _showDevMsg() {
    _showError('authLoginError', 'Authentication is not yet configured. Please check back later.');
  }

  function _friendlyError(e) {
    const map = {
      'auth/user-not-found': 'No account found with this email.',
      'auth/wrong-password': 'Incorrect password.',
      'auth/invalid-credential': 'Invalid email or password.',
      'auth/email-already-in-use': 'An account with this email already exists.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/invalid-email': 'Please enter a valid email address.',
      'auth/too-many-requests': 'Too many attempts. Please try again later.',
      'auth/popup-closed-by-user': 'Sign-in popup was closed.',
      'auth/account-exists-with-different-credential': 'An account with this email already exists using a different sign-in method.',
    };
    return map[e.code] || e.message || 'An error occurred.';
  }

  // ── Auth UI (header user badge) ────────────────────────────────────────────
  function _renderAuthUI() {
    // Update all auth-aware elements on the page
    let badge = document.getElementById('authBadge');
    if (!badge) return;

    if (_user) {
      const initial = (_user.name || '?')[0].toUpperCase();
      badge.innerHTML = `
        <div class="auth-user-badge">
          ${_user.photo
            ? `<img src="${_user.photo}" alt="" class="auth-avatar-img" referrerpolicy="no-referrer">`
            : `<span class="auth-avatar-letter">${initial}</span>`}
          <span class="auth-user-name">${_user.name}</span>
          <button class="auth-logout-btn" id="authLogoutBtn" title="Sign out">✕</button>
        </div>`;
      const lb = document.getElementById('authLogoutBtn');
      if (lb) lb.addEventListener('click', e => { e.stopPropagation(); logout(); });
    } else {
      badge.innerHTML = `<button class="auth-login-btn" id="authLoginBtn">Sign In</button>`;
      const lb = document.getElementById('authLoginBtn');
      if (lb) lb.addEventListener('click', showLogin);
    }
  }
})();
