// Handles each request: who is signed in, then which page or action.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Busboy = require("busboy");
const { InputError } = require("./errors");
const { PAGE_SIZE, MAX_PHOTOS } = require("./post-store");
const postViews = require("./post-views");
const messageViews = require("./message-views");
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
  "/static/manifest.json": ["application/manifest+json", fs.readFileSync(path.join(PUBLIC_DIR, "manifest.json"))],
  "/static/icon.svg": ["image/svg+xml", fs.readFileSync(path.join(PUBLIC_DIR, "img", "icon.svg"))],
};
for (const name of ["icon-180.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
  STATIC[`/static/${name}`] = ["image/png", fs.readFileSync(path.join(PUBLIC_DIR, "img", name))];
}
const MAX_FORM_BYTES = 32 * 1024;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
// The site shrinks photos in the browser before uploading when it can, so
// each is usually well under 1 MB; this is the limit when it can't.
const MAX_POST_PHOTO_BYTES = 12 * 1024 * 1024;
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
  declined: "Request deleted.",
  unbanned: "Unbanned.",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function text(res, status, body) {
  send(res, status, body, { "content-type": "text/plain; charset=utf-8" });
}
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
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
/** A multipart form: { fields, files } where files are Buffers of the field `field`, in order. */
function readMultipart(req, { field, maxFiles = 1, fileLimit }) {
  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = Busboy({ headers: req.headers, limits: { files: maxFiles, fileSize: fileLimit, fields: 20, fieldSize: 8 * 1024 } });
    } catch {
      return reject(new InputError("Please choose a photo."));
    }
    const fields = {};
    const files = [];
    let failed = false;
    busboy.on("field", (name, value) => {
      fields[name] = value;
    });
    busboy.on("file", (name, stream) => {
      if (name !== field) return stream.resume();
      const chunks = [];
      const slot = files.length;
      files.push(null);
      stream.on("data", (c) => chunks.push(c));
      stream.on("limit", () => {
        failed = true;
        reject(new InputError(`That photo is too big (the limit is ${Math.round(fileLimit / 1024 / 1024)} MB).`));
      });
      stream.on("end", () => {
        files[slot] = Buffer.concat(chunks);
      });
    });
    busboy.on("filesLimit", () => {
      failed = true;
      reject(new InputError(`Up to ${maxFiles} photos at a time.`));
    });
    busboy.on("finish", () => {
      if (!failed) resolve({ fields, files: files.filter((f) => f && f.length) });
    });
    busboy.on("error", reject);
    req.pipe(busboy);
  });
}
async function readUpload(req, field, limit) {
  const { files } = await readMultipart(req, { field, fileLimit: limit });
  return files[0] || null;
}
/** Splits off the extra row a list query fetched to tell whether there's a next page. */
function paged(rows, size) {
  const list = rows.slice(0, size);
  list.hasMore = rows.length > size;
  return list;
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
    if (p === "/favicon.ico") return redirect(res, "/static/icon-192.png");
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

    // The bottom bar's badges (not needed for photos, so worked out after them).
    const [messageCounts, activity] = await Promise.all([store.messageCounts(user.id), store.unseenActivity(user.id)]);
    user.badges = { messages: messageCounts.unread + messageCounts.requests, activity };

    // ── Home and profiles ────────────────────────────────────────────────
    const pageNumber = Math.min(500, Math.max(0, Number.parseInt(url.searchParams.get("page"), 10) || 0));
    const wantsJson = String(req.headers.accept || "").includes("application/json");
    if (p === "/" && method === "GET") {
      const tab = url.searchParams.get("tab") === "following" ? "following" : "nearby";
      const rows = tab === "nearby" ? await store.nearbyFeed(user, { page: pageNumber }) : await store.followingFeed(user, { page: pageNumber });
      return page(200, postViews.feedPage({ settings, user, formToken, tab, page: pageNumber, posts: paged(rows, PAGE_SIZE), notice }), extraHeaders);
    }
    m = p.match(/^\/@([A-Za-z0-9_.]{3,30})(\/follow|\/message)?$/);
    if (m) {
      const profile = await store.userByUsername(m[1]);
      if (!profile || !profile.username || profile.status !== "active") {
        return page(404, views.messagePage({ settings, user, title: "Not found", message: "There's nobody here by that name." }));
      }
      if (m[2] && method === "POST") {
        const form = await readForm(req);
        checkToken(form._token);
        if (m[2] === "/message") return redirect(res, `/messages/${await store.conversationWith(user.id, profile.id)}`);
        await store.toggleFollow(user.id, profile.id);
        return redirect(res, String(form.back || "").startsWith("/activity") ? "/activity" : `/@${profile.username}`);
      }
      if (!m[2] && method === "GET") {
        const rows = await store.profilePosts(profile.id, user.id, { page: pageNumber });
        const stats = await store.followStats(profile.id, user.id);
        return page(200, postViews.profilePage({ settings, user, formToken, profile, stats, page: pageNumber, posts: paged(rows, PAGE_SIZE * 3) }), extraHeaders);
      }
    }

    // ── The Nearby feed's location and distance ──────────────────────────
    if ((p === "/feed/location" || p === "/feed/radius") && method === "POST") {
      const form = await readForm(req);
      try {
        checkToken(form._token);
        if (p === "/feed/radius") await store.setFeedRadius(user.id, form.miles);
        else {
          const place = roundLocation(form.lat, form.lon);
          if (!place) throw new InputError("We couldn't get your location. Please allow location access and try again.");
          await store.setFeedLocation(user.id, place);
        }
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        const rows = await store.nearbyFeed(user);
        return page(400, postViews.feedPage({ settings, user, formToken, tab: "nearby", page: 0, posts: paged(rows, PAGE_SIZE), error: err.message }));
      }
      return redirect(res, "/?tab=nearby");
    }

    // ── New posts ────────────────────────────────────────────────────────
    if (p === "/new" && method === "GET") return page(200, postViews.newPostPage({ settings, user, formToken }), extraHeaders);
    if (p === "/new" && method === "POST") {
      const stored = [];
      let fields = {};
      try {
        checkToken(url.searchParams.get("_token"));
        const upload = await readMultipart(req, { field: "photos", maxFiles: MAX_PHOTOS, fileLimit: MAX_POST_PHOTO_BYTES });
        fields = upload.fields;
        if (!upload.files.length) throw new InputError("Please add at least one photo.");
        const photos = [];
        for (const file of upload.files) {
          const full = await processImage(file, "photo");
          const thumb = await processImage(file, "thumb");
          const photo = { photoKey: newKey(), thumbKey: newKey(), width: full.width, height: full.height };
          await media.put(photo.photoKey, full.buffer, full.contentType);
          stored.push(photo.photoKey);
          await media.put(photo.thumbKey, thumb.buffer, thumb.contentType);
          stored.push(photo.thumbKey);
          photos.push(photo);
        }
        let place = null;
        let areaName = null;
        if (fields.with_location === "on") {
          place = roundLocation(fields.lat, fields.lon);
          if (place) areaName = places.nearestTown(place.lat, place.lon);
        }
        const post = await store.createPost(user.id, { caption: fields.caption, photos, place, areaName });
        if (wantsJson) return sendJson(res, 200, { location: `/p/${post.id}` });
        return redirect(res, `/p/${post.id}`);
      } catch (err) {
        for (const key of stored) await media.remove(key).catch(() => {});
        if (!(err instanceof InputError) && !(err instanceof ImageError)) throw err;
        if (wantsJson) return sendJson(res, 400, { error: err.message });
        return page(400, postViews.newPostPage({ settings, user, formToken, error: err.message, caption: fields.caption }));
      }
    }

    // ── A post: likes, comments, editing ─────────────────────────────────
    m = p.match(/^\/p\/(\d{1,18})(\/.*)?$/);
    if (m) {
      const post = await store.post(m[1], user.id);
      if (!post) return page(404, views.messagePage({ settings, user, title: "Not found", message: "That post isn't there any more." }));
      const action = m[2] || "";
      const postPage = async (status, error = null) =>
        page(status, postViews.postPage({ settings, user, formToken, post: (await store.post(post.id, user.id)) || post, comments: await store.comments(post.id), error }));
      if (!action && method === "GET") return postPage(200);
      if (method === "POST") {
        const form = await readForm(req);
        try {
          checkToken(form._token);
          if (action === "/like") {
            const result = await store.toggleLike(post.id, user.id);
            if (wantsJson) return sendJson(res, 200, result);
            return redirect(res, String(req.headers.referer || "").startsWith(siteOrigin) ? new URL(req.headers.referer).pathname + new URL(req.headers.referer).search : `/p/${post.id}`);
          }
          if (action === "/comments") {
            const comment = await store.addComment(post.id, user.id, form.body);
            return redirect(res, `/p/${post.id}#c${comment.id}`);
          }
          const cm = action.match(/^\/comments\/(\d{1,18})\/delete$/);
          if (cm) {
            await store.deleteComment(cm[1], user.id);
            return redirect(res, `/p/${post.id}#comments`);
          }
          if (action === "/caption") {
            await store.updateCaption(post.id, user.id, form.caption);
            return redirect(res, `/p/${post.id}`);
          }
          if (action === "/delete") {
            for (const key of await store.deletePost(post.id, user.id)) await media.remove(key).catch(() => {});
            return redirect(res, `/@${user.username}`);
          }
        } catch (err) {
          if (!(err instanceof InputError)) throw err;
          if (wantsJson) return sendJson(res, 400, { error: err.message });
          return postPage(400, err.message);
        }
      }
    }

    // ── Activity ─────────────────────────────────────────────────────────
    if (p === "/activity" && method === "GET") {
      const items = await store.activity(user.id);
      const seenAt = (await store.user(user.id)).activity_seen_at;
      await store.markActivitySeen(user.id);
      user.badges.activity = 0;
      return page(200, messageViews.activityPage({ settings, user, formToken, items, seenAt }), extraHeaders);
    }

    // ── Messages ─────────────────────────────────────────────────────────
    if ((p === "/messages" || p === "/messages/requests") && method === "GET") {
      const requestsPage = p === "/messages/requests";
      const conversations = await store.inbox(user.id, { requests: requestsPage });
      const requests = requestsPage ? 0 : (await store.inbox(user.id, { requests: true })).length;
      return page(200, messageViews.inboxPage({ settings, user, conversations, requests, requestsPage, notice }), extraHeaders);
    }
    m = p.match(/^\/messages\/(\d{1,18})(\/.*)?$/);
    if (m) {
      const conversation = await store.conversation(m[1], user.id);
      if (!conversation) return page(404, views.messagePage({ settings, user, title: "Not found", message: "That chat isn't there any more." }));
      const action = m[2] || "";
      const chatPage = async (status, error = null) => {
        // A request stays unread until it's accepted, so the sender can't tell it was seen.
        if (!conversation.request_to_me) await store.markRead(conversation, user.id);
        const messages = await store.messages(conversation);
        const counts = await store.messageCounts(user.id);
        user.badges.messages = counts.unread + counts.requests;
        return page(status, messageViews.chatPage({ settings, user, formToken, conversation, messages, error }), extraHeaders);
      };
      if (!action && method === "GET") return chatPage(200);
      if (action === "/list" && method === "GET") {
        if (!conversation.request_to_me) await store.markRead(conversation, user.id);
        const messages = await store.messages(conversation);
        return send(res, 200, messageViews.messageList({ conversation, messages, user, formToken }));
      }
      if (action === "/snap" && method === "POST") {
        let key = null;
        try {
          checkToken(url.searchParams.get("_token"));
          await store.checkCanSend(conversation, user.id, "snap");
          const upload = await readUpload(req, "photo", MAX_POST_PHOTO_BYTES);
          if (!upload || !upload.length) throw new InputError("Please choose a photo.");
          const image = await processImage(upload, "photo");
          key = newKey();
          await media.put(key, image.buffer, image.contentType);
          await store.sendSnap(conversation, user.id, key);
        } catch (err) {
          if (key) await media.remove(key).catch(() => {});
          if (!(err instanceof InputError) && !(err instanceof ImageError)) throw err;
          if (wantsJson) return sendJson(res, 400, { error: err.message });
          return chatPage(400, err.message);
        }
        if (wantsJson) return sendJson(res, 200, { location: `/messages/${conversation.id}` });
        return redirect(res, `/messages/${conversation.id}`);
      }
      if (method === "POST") {
        const form = await readForm(req);
        try {
          checkToken(form._token);
          if (!action) {
            await store.checkCanSend(conversation, user.id, "text");
            await store.sendText(conversation, user.id, form.body);
            return redirect(res, `/messages/${conversation.id}`);
          }
          if (action === "/accept") {
            await store.acceptRequest(conversation, user.id);
            return redirect(res, `/messages/${conversation.id}`);
          }
          if (action === "/delete" && conversation.request_to_me) {
            for (const key of await store.deleteConversation(conversation)) await media.remove(key).catch(() => {});
            return redirect(res, "/messages/requests?done=declined");
          }
          if (action === "/keep") {
            await store.setKeep(conversation, user.id, form.keep === "on");
            return redirect(res, `/messages/${conversation.id}`);
          }
          const um = action.match(/^\/unsend\/(\d{1,18})$/);
          if (um) {
            const key = await store.unsend(conversation, um[1], user.id);
            if (key) await media.remove(key).catch(() => {});
            return redirect(res, `/messages/${conversation.id}`);
          }
          const sm = action.match(/^\/snaps\/(\d{1,18})$/);
          if (sm) {
            // View once: the photo is taken out of the message, shown, then deleted.
            const key = await store.openSnap(conversation, sm[1], user.id);
            if (!key) throw new InputError("That snap has already been opened.");
            const body = await media.get(key);
            await media.remove(key).catch(() => {});
            if (!body) throw new InputError("That snap isn't there any more.");
            const counts = await store.messageCounts(user.id);
            user.badges.messages = counts.unread + counts.requests;
            return page(200, messageViews.snapPage({ settings, user, conversation, image: { buffer: body, contentType: "image/webp" } }));
          }
        } catch (err) {
          if (!(err instanceof InputError)) throw err;
          return chatPage(400, err.message);
        }
      }
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
