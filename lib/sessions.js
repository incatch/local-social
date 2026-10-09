// "Remember this device": after someone signs in with an emailed code, their
// browser gets a pass that lasts a year (renewed as they use the site), so
// they aren't asked for a code again on that device.
//
// The pass is signed with a secret only the site knows, so it can't be
// forged or edited. Each pass carries the person's session_version; bumping
// that number makes all their existing passes useless.

const crypto = require("crypto");

const COOKIE = "ls_device";
const PRE_COOKIE = "ls_pre";
const LIFETIME_SECONDS = 365 * 24 * 60 * 60;
const RENEW_AFTER_SECONDS = 24 * 60 * 60;

function hmac(secret, text) {
  return crypto.createHmac("sha256", secret).update(text).digest("base64url");
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function createSessions(secret, { now = () => Date.now() } = {}) {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");

  return {
    /** The pass on this request, if genuine and not expired: { userId, version, needsRenewal }. */
    read(req) {
      const value = parseCookies(req.headers.cookie)[COOKIE];
      if (!value) return null;
      const [body, sig] = value.split(".");
      if (!body || !sig || !safeEqual(sig, hmac(secret, body))) return null;
      try {
        const { c, v, iat } = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        const ageSeconds = (now() - iat * 1000) / 1000;
        if (!Number.isInteger(c) || !Number.isInteger(v) || ageSeconds < -60 || ageSeconds > LIFETIME_SECONDS) {
          return null;
        }
        return { userId: c, version: v, needsRenewal: ageSeconds > RENEW_AFTER_SECONDS };
      } catch {
        return null;
      }
    },

    /** A Set-Cookie value giving `user` a fresh year-long pass. */
    issue(user) {
      const body = Buffer.from(
        JSON.stringify({ c: Number(user.id), v: user.session_version, iat: Math.floor(now() / 1000) }),
      ).toString("base64url");
      return `${COOKIE}=${body}.${hmac(secret, body)}; Path=/; Max-Age=${LIFETIME_SECONDS}; Secure; HttpOnly; SameSite=Lax`;
    },

    clear() {
      return `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
    },

    /** A token forms (and the page's own API calls) must send back, so other sites can't act as you. */
    formToken(user) {
      return hmac(secret, `form:${user.id}:${user.session_version}`);
    },

    checkFormToken(user, token) {
      return safeEqual(token || "", this.formToken(user));
    },

    /**
     * The same protection for the sign-in forms, used before anyone is
     * signed in: a random value in a cookie that the form must repeat.
     * Returns { token, setCookie } (setCookie is null if the cookie exists).
     */
    preToken(req) {
      const existing = parseCookies(req.headers.cookie)[PRE_COOKIE];
      if (existing && /^[\w-]{20,64}$/.test(existing)) return { token: existing, setCookie: null };
      const token = crypto.randomBytes(24).toString("base64url");
      return { token, setCookie: `${PRE_COOKIE}=${token}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax` };
    },

    checkPreToken(req, token) {
      const cookie = parseCookies(req.headers.cookie)[PRE_COOKIE];
      return Boolean(cookie) && safeEqual(token || "", cookie);
    },
  };
}

module.exports = { createSessions, parseCookies };
