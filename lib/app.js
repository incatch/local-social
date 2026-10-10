// Handles each request: who is signed in, then which page or action.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Busboy = require("busboy");
const { InputError } = require("./store");
const { ImageError, processImage } = require("./images");
const { KEY, newKey } = require("./media");
const { roundLocation } = require("./places");
const views = require("./views");
const adminViews = require("./admin-views");
const legal = require("./legal");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const STATIC = {
  "/static/css/style.css": ["text/css; charset=utf-8", fs.readFileSync(path.join(PUBLIC_DIR, "css", "style.css"))],
  "/static/js/app.js": ["text/javascript; charset=utf-8", fs.readFileSync(path.join(PUBLIC_DIR, "js", "app.js"))],
};
const MAX_FORM_BYTES = 32 * 1024;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const INVITE_COOKIE = "ls_invite";
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000",
  "permissions-policy": "camera=(self), microphone=(), geolocation=(self)",
};
const DONE = {
  saved: "Saved.",
  photo: "Profile photo updated.",
  photoRemoved: "Profile photo removed.",
  area: "Your area is updated.",
  areaCleared: "Your profile no longer shows an area.",
  everywhere: "You've been signed out on every other device.",
  inviteOnly: "Saved.",
  invite: "Invite created.",
  revoked: "Invite revoked.",
  banned: "Banned.",
  unbanned: "Unbanned.",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function text(res, status, body) {
  send(res, status, body, { "content-type": "text/plain; charset=utf-8" });
}
function redirect(res, location, headers = {}) {
  res.writeHead(303, { location, ...SECURITY_HEADERS, ...headers });
  res.end();
}
function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        reject(new InputError("That's too much."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")))));
    req.on("error", reject);
  });
}
/** The one uploaded file in a multipart form, as a Buffer (or null). */
function readUpload(req, field, limit) {
  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: limit, fields: 5 } });
    } catch {
      return reject(new InputError("Please choose a photo."));
    }
    let result = null;
    busboy.on("file", (name, stream) => {
      if (name !== field) return stream.resume();
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("limit", () => reject(new InputError(`That photo is too big (the limit is ${Math.round(limit / 1024 / 1024)} MB).`)));
      stream.on("end", () => {
        if (!stream.truncated) result = Buffer.concat(chunks);
      });
    });
    busboy.on("finish", () => resolve(result));
    busboy.on("error", reject);
    req.pipe(busboy);
  });
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
/** The visitor's address as the load balancer saw it (it adds it last). */
function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return forwarded[forwarded.length - 1] || req.socket.remoteAddress || "unknown";
}
/** At most `max` uses per key per hour. */
function createLimiter(max) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= max) return false;
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10000) hits.clear();
    return true;
  };
}

function createApp({
  store,
  sessions,
  sendEmail,
  media,
  places,
  auth, // { signedInUser(req) } — the household sign-in, checked by the load balancer (Admin only)
  admins, // emails allowed into Admin
  secret, // signs the admin forms' tokens
  siteUrl,
  timeZone = "America/Chicago",
  signOutUrl = null,
  log = console,
}) {
  const adminEmails = new Set(admins.map((e) => e.toLowerCase()));
  const codeLimit = createLimiter(20);
  const siteOrigin = new URL(siteUrl).origin;
  const adminToken = (email) => crypto.createHmac("sha256", secret).update(`admin-form:${email}`).digest("base64url");

  async function handle(req, res) {
    const url = new URL(req.url, siteUrl);
    const p = url.pathname;
    const method = req.method;

    if (p === "/health") return text(res, 200, "ok");
    if (STATIC[p]) {
      const [type, body] = STATIC[p];
      res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=300", ...SECURITY_HEADERS });
      return res.end(body);
    }
    // Forms only ever come from our own pages.
    if (method === "POST" && req.headers.origin && req.headers.origin !== siteOrigin) {
      return text(res, 403, "This form has to be sent from the site itself.");
    }
    if (p.startsWith("/admin")) return handleAdmin(req, res, url);

    const settings = await store.settings();
    const page = (status, html, headers) => send(res, status, html, headers);
    const back = (where, done) => redirect(res, `${where}${done ? `${where.includes("?") ? "&" : "?"}done=${done}` : ""}`);

    // Who's signed in (renewing their pass now and then).
    let user = null;
    const extraHeaders = {};
    const pass = sessions.read(req);
    if (pass) {
      const found = await store.user(pass.userId);
      if (found && found.session_version === pass.version && found.status === "active") {
        user = found;
        if (pass.needsRenewal) {
          extraHeaders["set-cookie"] = sessions.issue(user);
          await store.touch(user.id);
        }
      }
    }
    const formToken = user ? sessions.formToken(user) : null;
    const checkToken = (token) => {
      if (!user || !sessions.checkFormToken(user, token)) throw new InputError("This form has expired. Please go back, reload the page and try again.");
    };
    const notice = DONE[url.searchParams.get("done")] || null;

    // ── Pages anyone can see ─────────────────────────────────────────────
    if (p === "/terms") return page(200, legal.termsPage({ settings, user: user?.username ? user : null }));
    if (p === "/privacy") return page(200, legal.privacyPage({ settings, user: user?.username ? user : null }));
    let m = p.match(/^\/join\/([A-Za-z0-9-]{4,20})$/);
    if (m) {
      return redirect(res, user?.username ? "/" : user ? "/welcome" : "/sign-in", {
        "set-cookie": `${INVITE_COOKIE}=${encodeURIComponent(m[1].toUpperCase())}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`,
      });
    }

    // ── Signing in ───────────────────────────────────────────────────────
    if (p === "/sign-in" || p === "/sign-in/code") {
      if (user) return redirect(res, "/");
      const pre = sessions.preToken(req);
      const preHeaders = pre.setCookie ? { "set-cookie": pre.setCookie } : {};
      if (p === "/sign-in" && method === "GET") return page(200, views.signInPage({ settings, preToken: pre.token }), preHeaders);
      if (method !== "POST") return redirect(res, "/sign-in");
      const form = await readForm(req);
      if (!sessions.checkPreToken(req, form._token)) return page(400, views.signInPage({ settings, preToken: pre.token, error: "Please try again." }), preHeaders);
      if (p === "/sign-in") {
        if (!codeLimit(clientIp(req))) {
          return page(429, views.signInPage({ settings, preToken: pre.token, email: form.email, error: "Too many codes from here. Please try again in an hour." }), preHeaders);
        }
        try {
          const { email, code, minutes } = await store.newSigninCode(form.email);
          await sendEmail({
            to: email,
            subject: `${code} is your ${settings.site_name} code`,
            text: `Your sign-in code is ${code}\n\nIt works for ${minutes} minutes. If you didn't ask for it, you can ignore this email.\n`,
            html: `<p>Your sign-in code is</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>It works for ${minutes} minutes. If you didn't ask for it, you can ignore this email.</p>`,
          });
          return page(200, views.codePage({ settings, preToken: pre.token, email }), preHeaders);
        } catch (err) {
          if (!(err instanceof InputError)) throw err;
          return page(400, views.signInPage({ settings, preToken: pre.token, email: form.email, error: err.message }), preHeaders);
        }
      }
      try {
        const signedIn = await store.useSigninCode(form.email, form.code);
        return redirect(res, signedIn.username ? "/" : "/welcome", { "set-cookie": sessions.issue(signedIn) });
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        return page(400, views.codePage({ settings, preToken: pre.token, email: form.email, error: err.message }), preHeaders);
      }
    }
    if (p === "/sign-out" && method === "POST") {
      const form = await readForm(req);
      if (user) checkToken(form._token);
      return redirect(res, "/", { "set-cookie": sessions.clear() });
    }
    if (p === "/sign-out-page" && user) return page(200, views.signOutPage({ settings, formToken }));

    // ── Signed out: the welcome page only ────────────────────────────────
    if (!user) {
      if (p === "/" && method === "GET") return page(200, views.landingPage({ settings }));
      return redirect(res, "/sign-in");
    }

    // ── Finishing sign-up ────────────────────────────────────────────────
    if (p === "/welcome") {
      if (user.username) return redirect(res, "/");
      const invite = decodeURIComponent(parseCookies(req.headers.cookie)[INVITE_COOKIE] || "");
      if (method === "GET") return page(200, views.welcomePage({ settings, user, formToken, values: { invite } }), extraHeaders);
      const form = await readForm(req);
      try {
        checkToken(form._token);
        await store.finishSignup(user.id, form, { inviteOnly: settings.invite_only });
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        return page(400, views.welcomePage({ settings, user, formToken, values: form, error: err.message }));
      }
      return redirect(res, "/", { "set-cookie": `${INVITE_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax` });
    }
    if (!user.username) return redirect(res, "/welcome");

    // ── Photos ───────────────────────────────────────────────────────────
    if (p.startsWith("/media/") && method === "GET") {
      const key = p.slice(1);
      if (!KEY.test(key)) return text(res, 404, "Not found.");
      const body = await media.get(key);
      if (!body) return text(res, 404, "Not found.");
      res.writeHead(200, { "content-type": "image/webp", "content-length": body.length, "cache-control": "private, max-age=31536000, immutable", ...SECURITY_HEADERS });
      return res.end(body);
    }

    // ── Home and profiles ────────────────────────────────────────────────
    if (p === "/" && method === "GET") return page(200, views.homePage({ settings, user }), extraHeaders);
    m = p.match(/^\/@([A-Za-z0-9_.]{3,30})$/);
    if (m && method === "GET") {
      const profile = await store.userByUsername(m[1]);
      if (!profile || !profile.username || profile.status !== "active") {
        return page(404, views.messagePage({ settings, user, title: "Not found", message: "There's nobody here by that name." }));
      }
      return page(200, views.profilePage({ settings, user, profile }), extraHeaders);
    }

    // ── Settings ─────────────────────────────────────────────────────────
    const settingsPage = (status, error = null) => page(status, views.settingsPage({ settings, user, formToken, error, notice }));
    if (p === "/settings" && method === "GET") return settingsPage(200);
    if (p === "/settings/photo" && method === "POST") {
      try {
        checkToken(url.searchParams.get("_token"));
        const upload = await readUpload(req, "photo", MAX_PHOTO_BYTES);
        if (!upload || !upload.length) throw new InputError("Please choose a photo.");
        const image = await processImage(upload, "avatar");
        const key = newKey();
        await media.put(key, image.buffer, image.contentType);
        const old = await store.setPhoto(user.id, key);
        if (old) await media.remove(old).catch(() => {});
      } catch (err) {
        if (!(err instanceof InputError) && !(err instanceof ImageError)) throw err;
        return settingsPage(400, err.message);
      }
      return back("/settings", "photo");
    }
    if (method === "POST" && p.startsWith("/settings")) {
      const form = await readForm(req);
      try {
        checkToken(form._token);
        if (p === "/settings/profile") {
          await store.updateProfile(user.id, form);
          return back("/settings", "saved");
        }
        if (p === "/settings/photo/remove") {
          const old = await store.setPhoto(user.id, null);
          if (old) await media.remove(old).catch(() => {});
          return back("/settings", "photoRemoved");
        }
        if (p === "/settings/area") {
          const place = roundLocation(form.lat, form.lon);
          if (!place) throw new InputError("We couldn't get your location. Please allow location access and try again.");
          const name = places.nearestTown(place.lat, place.lon);
          if (!name) throw new InputError("We couldn't find a town near you.");
          await store.setArea(user.id, place, name);
          return back("/settings", "area");
        }
        if (p === "/settings/area/clear") {
          await store.setArea(user.id, null, null);
          return back("/settings", "areaCleared");
        }
        if (p === "/settings/delete") {
          if (String(form.confirm || "").trim().replace(/^@/, "").toLowerCase() !== user.username) {
            throw new InputError("To delete your account, type your username exactly.");
          }
          for (const key of await store.deleteUser(user.id)) await media.remove(key).catch(() => {});
          return page(200, views.messagePage({ settings, title: "Account deleted", message: "Your account and profile have been deleted." }), { "set-cookie": sessions.clear() });
        }
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        return settingsPage(400, err.message);
      }
    }
    if (p === "/sign-out/everywhere" && method === "POST") {
      const form = await readForm(req);
      checkToken(form._token);
      const updated = await store.signOutEverywhere(user.id);
      return redirect(res, "/settings?done=everywhere", { "set-cookie": sessions.issue(updated) });
    }

    return page(404, views.messagePage({ settings, user, title: "Not found", message: "That page doesn't exist." }));
  }

  // ── Admin ──────────────────────────────────────────────────────────────
  async function handleAdmin(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    const signedIn = await auth.signedInUser(req);
    if (!signedIn) return text(res, 401, "Please sign in.");
    if (!adminEmails.has(signedIn.email)) return text(res, 403, "This page is for the site's admins.");
    const settings = await store.settings();
    const admin = { email: signedIn.email, formToken: adminToken(signedIn.email), signOutUrl };
    const page = (status, html) => send(res, status, html);
    const back = (where, done) => redirect(res, `${where}${where.includes("?") ? "&" : "?"}done=${done}`);
    const notice = DONE[url.searchParams.get("done")] || null;

    let form = {};
    if (method === "POST") {
      form = await readForm(req);
      const given = Buffer.from(String(form._token || ""));
      const expected = Buffer.from(admin.formToken);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        return text(res, 403, "This form has expired. Go back, reload the page and try again.");
      }
    }

    if (p === "/admin" && method === "GET") {
      return page(200, adminViews.overview({ settings, admin, counts: await store.userCounts(), notice }));
    }
    if (p === "/admin/invite-only" && method === "POST") {
      await store.setInviteOnly(form.on === "true");
      return back("/admin", "inviteOnly");
    }
    const usersPage = async (status, error = null) => {
      const search = url.searchParams.get("q") || "";
      return page(status, adminViews.users({ settings, admin, search, timeZone, notice, error, list: await store.users({ search }) }));
    };
    if (p === "/admin/users" && method === "GET") return usersPage(200);
    let m = p.match(/^\/admin\/users\/(\d+)\/(ban|unban)$/);
    if (m && method === "POST") {
      try {
        if (m[2] === "ban") await store.ban(Number(m[1]), form.reason);
        else await store.unban(Number(m[1]));
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        return usersPage(400, err.message);
      }
      return back("/admin/users", m[2] === "ban" ? "banned" : "unbanned");
    }
    const invitesPage = async (status, error = null) =>
      page(status, adminViews.invites({ settings, admin, siteUrl, timeZone, notice, error, list: await store.invites() }));
    if (p === "/admin/invites" && method === "GET") return invitesPage(200);
    if (p === "/admin/invites" && method === "POST") {
      try {
        await store.createInvite(form);
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        return invitesPage(400, err.message);
      }
      return back("/admin/invites", "invite");
    }
    m = p.match(/^\/admin\/invites\/(\d+)\/revoke$/);
    if (m && method === "POST") {
      await store.revokeInvite(Number(m[1]));
      return back("/admin/invites", "revoked");
    }
    return text(res, 404, "Not found.");
  }

  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (err instanceof InputError) return text(res, 400, err.message);
      log.error(err);
      if (!res.headersSent) text(res, 500, "Something went wrong. Please try again.");
    }
  };
}

module.exports = { createApp, clientIp };
