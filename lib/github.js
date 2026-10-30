// "Sign in with GitHub" using GitHub's OAuth web flow (with state + PKCE).
// Only GitHub accounts that are linked to an rdrive user can sign in; GitHub
// proves who someone is, rdrive decides whether they're allowed in.
const crypto = require('node:crypto');

const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 1000;

class GitHubAuth {
  // opts: { clientId, clientSecret, publicUrl, authorizeUrl?, tokenUrl?, apiUrl? }
  constructor(opts) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.publicUrl = String(opts.publicUrl || '').replace(/\/+$/, '');
    this.authorizeUrl = opts.authorizeUrl || 'https://github.com/login/oauth/authorize';
    this.tokenUrl = opts.tokenUrl || 'https://github.com/login/oauth/access_token';
    this.apiUrl = opts.apiUrl || 'https://api.github.com';
    // state -> { mode, user, browserNonce, verifier, expires }
    this.pending = new Map();
  }

  static fromEnv(env) {
    const { RDRIVE_GITHUB_CLIENT_ID: clientId, RDRIVE_GITHUB_CLIENT_SECRET: clientSecret, RDRIVE_PUBLIC_URL: publicUrl } = env;
    if (!clientId && !clientSecret) return null;
    if (!clientId || !clientSecret || !publicUrl) {
      // Run without GitHub sign-in rather than refusing to start (passwords still work).
      const missing = ['RDRIVE_GITHUB_CLIENT_ID', 'RDRIVE_GITHUB_CLIENT_SECRET', 'RDRIVE_PUBLIC_URL'].filter((k) => !env[k]);
      console.warn(`GitHub sign-in is OFF: ${missing.join(', ')} not set.`);
      return null;
    }
    return new GitHubAuth({ clientId, clientSecret, publicUrl });
  }

  get callbackUrl() {
    return `${this.publicUrl}/auth/github/callback`;
  }

  // Start a flow. mode 'login' signs in; mode 'link' attaches GitHub to the signed-in user.
  // Returns the GitHub URL to redirect to, plus a nonce that must be set as a cookie on
  // this browser so the callback can't be completed from a different browser (login CSRF).
  begin(mode, user) {
    this.prune();
    if (this.pending.size >= MAX_PENDING) throw new Error('Too many sign-in attempts in progress. Try again shortly.');
    const state = crypto.randomBytes(24).toString('base64url');
    const browserNonce = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    this.pending.set(state, { mode, user: user || null, browserNonce, verifier, expires: Date.now() + FLOW_TTL_MS });
    const url = new URL(this.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      state,
      scope: '', // public profile only: rdrive just needs your GitHub user id
      allow_signup: 'false',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), browserNonce };
  }

  // Finish a flow. Returns { mode, user, github: { id, login } } or throws.
  async complete(state, code, browserNonce) {
    const flow = state && this.pending.get(state);
    if (state) this.pending.delete(state); // single use
    if (!flow || flow.expires < Date.now()) throw new Error('This sign-in link expired. Please try again.');
    const a = Buffer.from(String(browserNonce || ''));
    const b = Buffer.from(flow.browserNonce);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Error('Sign-in must be finished in the same browser it was started in.');
    }
    if (!code) throw new Error('GitHub did not return an authorization code.');

    const tokenRes = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.callbackUrl,
        code_verifier: flow.verifier,
      }),
    });
    const token = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !token.access_token) {
      throw new Error(`GitHub sign-in failed${token.error_description ? `: ${token.error_description}` : '.'}`);
    }

    const userRes = await fetch(`${this.apiUrl}/user`, {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rdrive' },
    });
    const gh = await userRes.json().catch(() => ({}));
    if (!userRes.ok || typeof gh.id !== 'number' || !gh.login) throw new Error('Could not read your GitHub profile.');
    // The access token isn't needed after this, so it's never stored.
    return { mode: flow.mode, user: flow.user, github: { id: gh.id, login: gh.login } };
  }

  prune() {
    const now = Date.now();
    for (const [k, f] of this.pending) if (f.expires < now) this.pending.delete(k);
  }
}

// Look up a GitHub user's permanent numeric id from their username (public API, no auth).
async function lookupGithubUser(login, apiUrl = 'https://api.github.com') {
  const res = await fetch(`${apiUrl}/users/${encodeURIComponent(login)}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'rdrive' },
  });
  if (res.status === 404) throw new Error(`GitHub user "${login}" not found.`);
  if (!res.ok) throw new Error(`GitHub lookup failed (${res.status}).`);
  const gh = await res.json();
  return { id: gh.id, login: gh.login };
}

module.exports = { GitHubAuth, lookupGithubUser };
