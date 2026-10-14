// Handles each request: who is signed in, then which page or action.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Busboy = require("busboy");
const { InputError } = require("./errors");
const { TeenLocationNeeded, ParentEmailNeeded } = require("./store");
const teenViews = require("./teen-views");
const { createPolitics } = require("./politics");
const { checkPhoto } = require("./provenance");
const { reachMiles } = require("./ripples");
const signalViews = require("./signal-views");
const growthViews = require("./growth-views");
const QRCode = require("qrcode");
const { BADGES } = require("./badges");
const betaViews = require("./beta-views");
const { createNudges, checkOffToken, dayIn } = require("./nudges");
const { createPush } = require("./push");
const firstLookViews = require("./first-look-views");
const irlViews = require("./irl-views");
const { featureOn } = require("./features");
const { streakFrom } = require("./irl-store");
const dropViews = require("./drop-views");
const { createPublicPlaces, meters, PLACE_METERS } = require("./public-places");
const { isVideo, processClip } = require("./video");
const { renderReel } = require("./reels");
const { tidySource } = require("./founding-store");
const foundingViews = require("./founding-views");

/** A "2026-10-10T18:00" from a form, read as local time in `timeZone`. */
function zonedLocalToDate(local, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ""));
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // What that UTC moment looks like in the zone tells us the zone's offset.
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(asUtc)).map((p) => [p.type, p.value]));
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(asUtc - (shown - asUtc));
}
/** This week (starting Monday, in the site's time zone): { week: "2026-10-05", weekStart: Date, lastWeek }. */
function weekInfo(timeZone, now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday);
  const minus = (iso, days) => new Date(Date.parse(`${iso}T12:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const week = minus(today, back);
  return { week, weekStart: zonedLocalToDate(`${week}T00:00`, timeZone), lastWeek: minus(week, 7), weekday };
}
const { PAGE_SIZE, MAX_PHOTOS } = require("./post-store");
const postViews = require("./post-views");
const messageViews = require("./message-views");
const { ImageError, processImage } = require("./images");
const { KEY, MODERATED_KEY, newKey } = require("./media");
const { allowAll } = require("./screening");
const { REASONS } = require("./safety-store");
const safetyViews = require("./safety-views");
const { roundLocation, milesBetween } = require("./places");
const views = require("./views");
const adminViews = require("./admin-views");
const legal = require("./legal");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const STATIC = {
  "/static/css/style.css": ["text/css; charset=utf-8", fs.readFileSync(path.join(PUBLIC_DIR, "css", "style.css"))],
  "/static/js/app.js": ["text/javascript; charset=utf-8", fs.readFileSync(path.join(PUBLIC_DIR, "js", "app.js"))],
  "/sw.js": ["text/javascript; charset=utf-8", fs.readFileSync(path.join(PUBLIC_DIR, "js", "sw.js"))],
  "/static/vendor/leaflet.js": ["text/javascript; charset=utf-8", fs.readFileSync(require.resolve("leaflet/dist/leaflet.js"))],
  "/static/vendor/leaflet.css": ["text/css; charset=utf-8", fs.readFileSync(require.resolve("leaflet/dist/leaflet.css"))],
  "/static/manifest.json": ["application/manifest+json", fs.readFileSync(path.join(PUBLIC_DIR, "manifest.json"))],
  "/static/icon.svg": ["image/svg+xml", fs.readFileSync(path.join(PUBLIC_DIR, "img", "icon.svg"))],
  "/static/fonts/jakarta.woff2": ["font/woff2", fs.readFileSync(path.join(PUBLIC_DIR, "fonts", "jakarta.woff2"))],
};
for (const name of ["icon-180.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
  STATIC[`/static/${name}`] = ["image/png", fs.readFileSync(path.join(PUBLIC_DIR, "img", name))];
}
const MAX_FORM_BYTES = 32 * 1024;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
// The site shrinks photos in the browser before uploading when it can, so
// each is usually well under 1 MB; this is the limit when it can't.
const MAX_POST_PHOTO_BYTES = 12 * 1024 * 1024;
// Video clips (when they are on): up to this big before we cut them to 15 seconds.
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
// Moment Reels: from this many posts, with up to this many photos and clips.
const REEL_MIN_POSTS = 3;
const REEL_MAX_ITEMS = 9;
const INVITE_COOKIE = "ls_invite";
// Which ad or link brought someone (?utm_source=…&utm_campaign=… or ?ref=…), until they join.
const SOURCE_COOKIE = "ls_src";
// Pull Up: how close you have to be to say you're there (places are rounded to about a mile).
const PULLUP_MILES = 1.25;
/** Can people still pull up? Posts with a place for a day; plans until they end. */
function pullUpOpen(target) {
  if (target.lat === null || target.lat === undefined) return false;
  if (target.kind === "post") return Date.now() - new Date(target.created_at).getTime() < 24 * 3600 * 1000;
  return target.status !== "removed" && target.kind === "signal" && target.signal_kind === "plan" && new Date(target.expires_at) > new Date();
}
// How far someone can be from their saved spot before we offer to update it.
const MOVED_MILES = 50;
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
  moderated: "Done.",
  legalHold: "Moved to legal hold and the account was banned. Report it to the NCMEC CyberTipline (see the note on the queue page).",
  banned: "Banned.",
  declined: "Request deleted.",
  unbanned: "Unbanned.",
  emailsOn: "We'll email you when messages are waiting.",
  emailsOff: "No more emails about messages or what's new. (Sign-in codes still come by email.)",
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
/**
 * A multipart form: { fields, files, heads } where files are Buffers of the
 * field `field`, in order, and heads[i] (when `withHeads`) is the start of
 * the i-th original photo, sent as "head<i>" by the page's script.
 */
const HEAD_BYTES = 512 * 1024;
function readMultipart(req, { field, maxFiles = 1, fileLimit, withHeads = false }) {
  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = Busboy({ headers: req.headers, limits: { files: withHeads ? maxFiles * 2 : maxFiles, fileSize: fileLimit, fields: 20, fieldSize: 8 * 1024 } });
    } catch {
      return reject(new InputError("Please choose a photo."));
    }
    const fields = {};
    const files = [];
    const heads = [];
    let failed = false;
    busboy.on("field", (name, value) => {
      fields[name] = value;
    });
    busboy.on("file", (name, stream) => {
      const head = withHeads && /^head(\d{1,2})$/.exec(name);
      if (head && Number(head[1]) < maxFiles) {
        const chunks = [];
        let size = 0;
        stream.on("data", (c) => {
          if (size < HEAD_BYTES) chunks.push(c);
          size += c.length;
        });
        stream.on("end", () => {
          heads[Number(head[1])] = Buffer.concat(chunks).subarray(0, HEAD_BYTES);
        });
        return;
      }
      if (name !== field) return stream.resume();
      if (files.length >= maxFiles) {
        failed = true;
        reject(new InputError(`Up to ${maxFiles} photos at a time.`));
        return stream.resume();
      }
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
      if (!failed) resolve({ fields, files: files.filter((f) => f && f.length), heads });
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
/** Is this account a teen's (under 18 in teen mode)? */
const isTeen = (u) => Boolean(u && u.teen_until && String(u.teen_until) > new Date().toISOString().slice(0, 10));

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
  screener = allowAll, // photo screening (screening.js)
  fetch: fetchFn = globalThis.fetch, // for looking up political figures (politics.js)
  pushSender = null, // sends one phone notification (tests pass a fake)
  log = console,
}) {
  const adminEmails = new Set(admins.map((e) => e.toLowerCase()));
  const politics = createPolitics({ store, fetch: fetchFn, log });
  let badges = async () => {}; // set per request (needs the settings)
  const codeLimit = createLimiter(20);
  const consentLimit = createLimiter(3);
  const feedbackLimit = createLimiter(10);
  const waitlistLimit = createLimiter(10);
  const publicPlaces = createPublicPlaces({ store, fetch: fetchFn, log });
  const push = createPush({ store, secret, sender: pushSender, log });
  const nudges = createNudges({ store, sendEmail, places, siteUrl, secret, timeZone, isTeen, log });
  // Who used the site when (Admin → Beta): saved at most every 5 minutes per person.
  const lastActive = new Map();
  // ── Moment Reels ──
  // One reel per set of posts someone can see (usually everyone sees the same
  // set, so it's made once). Made one at a time per container, in the background.
  let reelQueue = Promise.resolve();
  async function makeReel(moment, ids, row, viewerId) {
    try {
      const posts = await store.postsByIds(ids, viewerId);
      const items = [];
      for (const post of posts) {
        for (const ph of post.photos) {
          if (items.length >= REEL_MAX_ITEMS) break;
          const image = await media.get(ph.photo_key);
          if (!image) continue;
          const video = ph.video_key ? await media.get(ph.video_key) : null;
          items.push(video ? { kind: "video", video, image } : { kind: "photo", image });
        }
      }
      const people = new Set(posts.map((x) => String(x.user_id))).size;
      const settings = await store.settings();
      const out = await renderReel({
        items,
        title: moment.title,
        subtitle: `${people} ${people === 1 ? "person" : "people"} · ${posts.length} post${posts.length === 1 ? "" : "s"}`,
        seed: moment.id,
        site: settings.site_name,
        tagline: settings.tagline || "Your world. Happening now.",
        url: new URL(siteUrl).host,
      });
      const videoKey = newKey("media", "mp4");
      const posterKey = newKey();
      await media.put(videoKey, out.video, "video/mp4");
      const poster = await processImage(out.poster, "photo");
      await media.put(posterKey, poster.buffer, poster.contentType);
      await store.finishReel(row.id, { videoKey, posterKey });
    } catch (err) {
      log.error("moment reel failed", err);
      await store.failReel(row.id).catch(() => {});
    }
  }
  /** The reel of `moment` for what `viewerId` may see: finds it, or starts making it. */
  async function reelFor(moment, viewerId, { start = true, wait = false } = {}) {
    const ids = await store.momentPostIds(moment.id, viewerId);
    if (ids.length < REEL_MIN_POSTS) return null;
    const hash = crypto.createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 32);
    const existing = await store.reelFor(moment.id, hash);
    if (!start || (existing && existing.status !== "failed")) return existing || { status: "none" };
    const claimed = await store.claimReel(moment.id, hash);
    if (claimed) {
      const job = (reelQueue = reelQueue.then(() => makeReel(moment, ids, claimed, viewerId)));
      if (wait) await job;
    }
    return (await store.reelFor(moment.id, hash)) || { status: "none" };
  }

  /** After someone does something real: does it keep a squad's streak going? */
  async function together(settings, userId) {
    if (settings.features.squads === "off") return;
    await store.checkTogether(userId, weekInfo(timeZone)).catch((err) => log.error("squad streaks", err));
  }
  function noteActive(userId) {
    const now = Date.now();
    if (now - (lastActive.get(userId) || 0) < 5 * 60 * 1000) return;
    lastActive.set(userId, now);
    if (lastActive.size > 50000) lastActive.clear();
    store.recordActive(userId, dayIn(timeZone)).catch((err) => log.error("recording activity failed", err));
  }
  /** Emails a parent the link to OK their teen's account. */
  async function askParent(teen, { token, email }, settings) {
    const link = `${siteUrl}/consent/${token}`;
    await sendEmail({
      to: email,
      subject: `${teen.display_name} would like to join ${settings.site_name}`,
      text: `${teen.display_name} (${teen.email}) is signing up for ${settings.site_name}, a site for sharing photos with people nearby, and gave your email as their parent's.\n\nPeople under 18 are in a separate, teens-only part of ${settings.site_name}: adults can't see them or message them.\n\nTo say yes or no: ${link}\n\nIf you don't know what this is, you can ignore it.\n`,
      html: `<p><strong>${teen.display_name.replace(/[<>&]/g, "")}</strong> is signing up for ${settings.site_name}, a site for sharing photos with people nearby, and gave your email as their parent's.</p><p>People under 18 are in a separate, teens-only part of ${settings.site_name}: adults can't see them or message them.</p><p><a href="${link}">Say yes or no</a></p><p>If you don't know what this is, you can ignore it.</p>`,
    });
  }
  const siteOrigin = new URL(siteUrl).origin;
  // ── Safety helpers ─────────────────────────────────────────────────────
  /** Copies a stored photo into the moderated-out store; returns the copy's key. */
  async function keepCopy(key) {
    const body = key ? await media.get(key) : null;
    if (!body) return null;
    const copy = newKey("moderated");
    await media.put(copy, body, "image/webp");
    return copy;
  }
  /** A photo refused by screening: keep a copy (with the labels), and say no. */
  async function refuse(user, source, image, verdict) {
    const copy = newKey("moderated");
    await media.put(copy, image.buffer, image.contentType);
    await store.addModerated({ source, userId: user.id, username: user.username, mediaKeys: [copy], labels: verdict.labels, decision: "refused" });
    alertAdmins(`A ${{ avatar: "profile photo", snap: "view-once photo", upload: "post photo" }[source] || source} from @${user.username} was refused by photo screening.`);
    throw new InputError(
      source === "upload"
        ? "One of these photos can't be shared on Radius: it looks like it breaks the rules on nudity, violence or hate."
        : `This photo can't be ${source === "avatar" ? "used as a profile photo" : "sent"}: it looks like it breaks the rules on nudity, violence or hate.`,
    );
  }
  // Emails to the admins about new reports and feedback: at most one of each every 15 minutes,
  // except reports involving minors, which go straight away.
  const lastAlert = {};
  function alertAdmins(text, { urgent = false, subject = "Radius moderation", link = "/admin/moderation" } = {}) {
    const now = Date.now();
    if (!urgent && now - (lastAlert[subject] || 0) < 15 * 60 * 1000) return;
    lastAlert[subject] = now;
    for (const to of adminEmails) {
      sendEmail({
        to,
        subject: `${urgent ? "URGENT: " : ""}${subject}: ${text.slice(0, 80)}`,
        text: `${text}\n\nSee it: ${siteUrl}${link}\n`,
        html: `<p>${text.replace(/[<>&]/g, "")}</p><p><a href="${siteUrl}${link}">Open Admin</a></p>`,
      }).catch((err) => log.error("admin alert failed", err));
    }
  }

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
    badges = async (uid) => {
      if (settings.badges_enabled) await store.checkBadges(uid, { timeZone, rippleTop: settings.ripple_3_at, foundingLimit: settings.founding_limit }).catch((err) => log.error("badges", err));
    };
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
    // Remember which ad brought them (last one wins), so Admin → Beta can say which ads work.
    const cookies = parseCookies(req.headers.cookie);
    const fromAd = method === "GET" && !user?.username ? url.searchParams.get("utm_source") || url.searchParams.get("ref") : null;
    const track = fromAd ? tidySource([fromAd, url.searchParams.get("utm_campaign")].filter(Boolean).join("/")) : null;
    const withTrack = (headers = {}) =>
      track ? { ...headers, "set-cookie": [].concat(headers["set-cookie"] || [], `${SOURCE_COOKIE}=${encodeURIComponent(track)}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax`) } : headers;
    const source = track || decodeURIComponent(cookies[SOURCE_COOKIE] || "") || null;
    /** Who can join right now: invite only, unless founding sign-ups are open and spots are left. */
    const joinRules = async () => {
      const founding = await store.foundingStatus(settings);
      return { founding, inviteOnly: settings.invite_only && !founding.open };
    };

    // ── Pages anyone can see ─────────────────────────────────────────────
    if (p === "/terms") return page(200, legal.termsPage({ settings, user: user?.username ? user : null }));
    if (p === "/privacy") return page(200, legal.privacyPage({ settings, user: user?.username ? user : null }));
    let m = p.match(/^\/join\/([A-Za-z0-9-]{4,20})$/);
    if (m) {
      return redirect(
        res,
        user?.username ? "/" : user ? "/welcome" : "/sign-in",
        withTrack({ "set-cookie": `${INVITE_COOKIE}=${encodeURIComponent(m[1].toUpperCase())}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax` }),
      );
    }

    // ── The waitlist (once the founding spots are full) ──
    if (p === "/waitlist" && method === "POST" && !user?.username) {
      const form = await readForm(req);
      const rules = await joinRules();
      try {
        if (user) checkToken(form._token);
        if (!waitlistLimit(`waitlist:${clientIp(req)}`)) throw new InputError("Please try again in a little while.");
        await store.joinWaitlist(user ? user.email : form.email, source);
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        return page(400, views.landingPage({ settings, founding: rules.founding, inviteOnly: rules.inviteOnly, error: err.message }));
      }
      return page(200, views.landingPage({ settings, founding: rules.founding, inviteOnly: rules.inviteOnly, waitlisted: true }));
    }

    // ── Signing in ───────────────────────────────────────────────────────
    if (p === "/sign-in" || p === "/sign-in/code") {
      if (user) return redirect(res, "/");
      const pre = sessions.preToken(req);
      const preHeaders = pre.setCookie ? { "set-cookie": pre.setCookie } : {};
      if (p === "/sign-in" && method === "GET") return page(200, views.signInPage({ settings, preToken: pre.token }), withTrack(preHeaders));
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

    // ── A parent's yes or no (teen mode; no sign-in needed: the link is the key) ──
    m = p.match(/^\/consent\/([A-Za-z0-9_-]{20,64})$/);
    if (m) {
      const teen = await store.teenForConsent(m[1]);
      if (!teen) return page(404, views.messagePage({ settings, title: "Link not found", message: "This link has already been used, or it's out of date." }));
      if (method === "GET") return page(200, teenViews.consentPage({ settings, teen }));
      const form = await readForm(req);
      if (form.answer === "yes") {
        await store.approveConsent(teen.id);
        return page(200, views.messagePage({ settings, title: "Thank you", message: `${teen.display_name} can now use ${settings.site_name}.` }));
      }
      if (form.answer === "no") {
        for (const key of await store.deleteUser(teen.id)) await media.remove(key).catch(() => {});
        return page(200, views.messagePage({ settings, title: "Done", message: "We've deleted the account." }));
      }
      return redirect(res, p);
    }

    // ── Turning off email nudges (the link in every email; no sign-in needed) ──
    m = p.match(/^\/emails\/off\/(\d{1,18})\/([A-Za-z0-9_-]{32})$/);
    if (m) {
      if (!checkOffToken(secret, m[1], m[2])) return page(404, views.messagePage({ settings, user, title: "Link expired", message: "That link doesn't work. You can turn emails off in Settings." }));
      if (method === "POST") {
        await store.setEmailNudges(m[1], false);
        return page(200, betaViews.emailsOffPage({ settings, done: true }));
      }
      return page(200, betaViews.emailsOffPage({ settings, action: p }));
    }

    // ── Signed out: the welcome page only ────────────────────────────────
    if (!user) {
      if (p === "/" && method === "GET") {
        const rules = await joinRules();
        return page(200, views.landingPage({ settings, founding: rules.founding, inviteOnly: rules.inviteOnly }), withTrack());
      }
      return redirect(res, "/sign-in");
    }

    // ── Finishing sign-up ────────────────────────────────────────────────
    if (p === "/welcome") {
      if (user.username) return redirect(res, "/");
      const invite = decodeURIComponent(parseCookies(req.headers.cookie)[INVITE_COOKIE] || "");
      const rules = await joinRules();
      const joinSettings = { ...settings, invite_only: rules.inviteOnly };
      if (method === "GET") return page(200, views.welcomePage({ settings: joinSettings, user, formToken, values: { invite } }), extraHeaders);
      const form = await readForm(req);
      try {
        checkToken(form._token);
        // Teen mode limited to some states: the state comes from their (rounded) location.
        const place = roundLocation(form.lat, form.lon);
        const region = place ? places.usState(place.lat, place.lon) : null;
        const joined = await store.finishSignup(user.id, form, { inviteOnly: rules.inviteOnly, settings, region, located: Boolean(place) });
        if (source) await store.setSignupSource(user.id, source);
        if (place && joined.teen_until) await store.setArea(user.id, place, places.nearestTown(place.lat, place.lon));
        if (joined.consentToken) await askParent(joined, { token: joined.consentToken, email: joined.parent_email }, settings);
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        const step = err instanceof TeenLocationNeeded ? "location" : err instanceof ParentEmailNeeded ? "parent" : null;
        return page(400, views.welcomePage({ settings: joinSettings, user, formToken, values: form, error: err.message, step }));
      }
      return redirect(res, "/hello", {
        "set-cookie": [`${INVITE_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`, `${SOURCE_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`],
      });
    }
    if (!user.username) return redirect(res, "/welcome");
    // Teens waiting for a parent's OK can only see the waiting page.
    if (user.needs_parent_consent && !user.parent_consent_at) {
      if (p === "/waiting/resend" && method === "POST") {
        const form = await readForm(req);
        checkToken(form._token);
        try {
          if (!consentLimit(`consent:${user.id}`)) throw new InputError("We've sent a few already. Please wait an hour and try again.");
          const renewed = await store.renewConsent(user.id, form.parent_email || null);
          await askParent(user, renewed, settings);
        } catch (err) {
          if (!(err instanceof InputError)) throw err;
          return page(400, teenViews.waitingPage({ settings, user: await store.user(user.id), formToken, error: err.message }));
        }
        return page(200, teenViews.waitingPage({ settings, user: await store.user(user.id), formToken, notice: "Sent! Ask them to check their email." }));
      }
      return page(200, teenViews.waitingPage({ settings, user, formToken }));
    }

    // ── Photos ───────────────────────────────────────────────────────────
    if (p.startsWith("/media/") && method === "GET") {
      const key = p.slice(1);
      if (!KEY.test(key)) return text(res, 404, "Not found.");
      const body = await media.get(key);
      if (!body) return text(res, 404, "Not found.");
      const type = key.endsWith(".mp4") ? "video/mp4" : "image/webp";
      const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": "private, max-age=31536000, immutable", ...SECURITY_HEADERS };
      // Phones fetch videos in pieces ("Range" requests); iPhones won't play them otherwise.
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
      if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
        let end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        if (start >= body.length || start > end) {
          res.writeHead(416, { "content-range": `bytes */${body.length}`, ...SECURITY_HEADERS });
          return res.end();
        }
        res.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 });
        return res.end(body.subarray(start, end + 1));
      }
      res.writeHead(200, { ...base, "content-length": body.length });
      return res.end(body);
    }

    // The bottom bar's badges (not needed for photos, so worked out after them).
    const [messageCounts, activity] = await Promise.all([store.messageCounts(user.id), store.unseenActivity(user.id)]);
    user.badges = { messages: messageCounts.unread + messageCounts.requests, activity };
    user.formToken = formToken;
    noteActive(user.id);
    /** The Pull Up card for a post or plan (or nothing). */
    const pullUpHtml = async (target) => {
      if (!featureOn(settings, "pullup", user) || target.lat === null || target.lat === undefined) return "";
      const t = { kind: target.kind, id: target.id };
      const list = await store.pullUps(t, user.id);
      const open = pullUpOpen(target);
      if (!open && !list.length) return "";
      return irlViews.pullUpBlock({ base: `/${target.kind === "post" ? "p" : "s"}/${target.id}`, own: String(target.user_id) === String(user.id), mine: await store.myPullUp(t, user.id), list, formToken, open });
    };
    // Teen mode: how Nearby works for teens.
    user.is_teen = isTeen(user);
    user.show_distance = !user.is_teen || settings.teen_show_distance;
    user.min_radius = user.is_teen ? settings.teen_min_radius : 0;
    user.ai_filter = settings.nearby_ai_filter;

    // ── Home and profiles ────────────────────────────────────────────────
    const pageNumber = Math.min(500, Math.max(0, Number.parseInt(url.searchParams.get("page"), 10) || 0));
    const wantsJson = String(req.headers.accept || "").includes("application/json");
    if (p === "/" && method === "GET") {
      const tab = url.searchParams.get("tab") === "following" ? "following" : "nearby";
      if (tab === "following") {
        const rows = await store.followingFeed(user, { page: pageNumber });
        return page(200, postViews.feedPage({ settings, user, formToken, tab, page: pageNumber, posts: paged(rows, PAGE_SIZE), notice }), extraHeaders);
      }
      // Visiting another town: look around there (nothing about your own spot changes).
      const visitText = url.searchParams.get("visit");
      const town = visitText ? places.findTown(visitText) || places.searchTowns(visitText, { near: user.feed_lat !== null ? { lat: user.feed_lat, lon: user.feed_lon } : null })[0] : null;
      const viewer = town ? { ...user, feed_lat: town.lat, feed_lon: town.lon, feed_radius_miles: Math.max(user.feed_radius_miles, 10) } : user;
      const posts = paged(await store.nearbyFeed(viewer, { page: pageNumber, s: settings }), PAGE_SIZE);
      const here = user.feed_lat !== null ? places.nearestTown(user.feed_lat, user.feed_lon) : null;
      const picker = growthViews.townPicker({ user, formToken, here, visiting: town?.label, around: user.feed_lat !== null ? places.townsAround(user.feed_lat, user.feed_lon) : [] });
      const banner = town ? growthViews.visitBanner(town.label) : visitText ? `<p class="error">We couldn't find a town called “${String(visitText).replace(/[<>&"]/g, "")}”.</p>` : "";
      // Today's recap, in the evening, when there's enough to show.
      let recap = "";
      if (!town && pageNumber === 0 && settings.today_recap_enabled && here) {
        const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(new Date())) % 24;
        if (hour >= 17 && (await store.nearbyFeed(user, { s: { ...settings, ripples_enabled: false }, when: { since: new Date(Date.now() - 86400000) }, countOnly: true })) >= 3) {
          recap = growthViews.recapCard(growthViews.townOf(here));
        }
      }
      // "4 new since you last looked", then "you're all caught up" and a year ago, at the end.
      let newCount = 0;
      if (!town && pageNumber === 0 && user.feed_lat !== null) {
        const before = await store.markNearbySeen(user.id);
        if (before) newCount = await store.nearbyFeed(user, { s: settings, when: { since: before }, countOnly: true });
      }
      const moments = pageNumber === 0 && settings.moments_enabled ? await store.momentsNear(viewer) : [];
      const signals = pageNumber === 0 && settings.signals_enabled ? await store.signalsNear(viewer, { limit: 20 }) : null;
      const yearAgo = !posts.hasMore && viewer.feed_lat !== null ? await store.nearbyFeed(viewer, { s: settings, when: { yearsAgo: true }, limit: 6 }) : [];
      // Drops and Where It's At, when they're on for this person.
      let discover = "";
      if (pageNumber === 0 && viewer.feed_lat !== null) {
        const drops = featureOn(settings, "drops", user) ? (await store.dropsNear(user, { lat: viewer.feed_lat, lon: viewer.feed_lon, miles: 5 })).filter((d) => !d.found).length : null;
        discover = dropViews.discoverRow({ drops, where: featureOn(settings, "heatmap", user) && !town });
      }
      return page(200, postViews.feedPage({ settings, user, formToken, tab, page: pageNumber, posts, notice, newCount, yearAgo, moments, signals, picker, banner, recap, discover, visiting: town?.label || null }), extraHeaders);
    }
    // ── Town search (for visiting another town) ──
    if (p === "/places/search" && method === "GET") {
      const near = user.feed_lat !== null ? { lat: user.feed_lat, lon: user.feed_lon } : null;
      return sendJson(res, 200, places.searchTowns(url.searchParams.get("q"), { near, limit: 8 }).map((t) => t.label));
    }

    // ── The first look (right after joining) ──
    if (p === "/hello" && method === "GET") {
      const town = user.feed_lat !== null ? places.nearestTown(user.feed_lat, user.feed_lon) : null;
      let best = [];
      if (user.feed_lat !== null) {
        const week = await store.nearbyFeed(user, { s: { ...settings, ripples_enabled: false }, when: { since: new Date(Date.now() - 7 * 86400000) }, limit: 60 });
        best = week
          .filter((x) => x.photos && x.photos.length)
          .sort((a, b) => b.like_count + b.comment_count - (a.like_count + a.comment_count))
          .slice(0, 9);
      }
      return page(
        200,
        firstLookViews.helloPage({
          settings,
          user,
          formToken,
          town,
          best,
          peopleCount: await store.countPeopleNear(user, 10),
          memberNumber: await store.memberNumber(user.id),
          people: await store.peopleNearby(user, 5),
          publicKey: push.publicKey,
        }),
        extraHeaders,
      );
    }

    // ── Phone notifications ──
    if (p.startsWith("/push/") && method === "POST") {
      const form = await readForm(req);
      try {
        checkToken(form._token);
        if (p === "/push/subscribe") await store.addPushSubscription(user.id, { endpoint: form.endpoint, p256dh: form.p256dh, auth: form.auth, device: req.headers["user-agent"] });
        else if (p === "/push/unsubscribe") await store.removePushSubscription(user.id, form.endpoint);
        else if (p === "/push/test") {
          const sent = await push.toUser(user.id, { body: "Notifications are on. You'll know the moment something happens 👋", url: "/activity", tag: "test" });
          return sendJson(res, 200, { ok: true, sent });
        } else return sendJson(res, 404, { error: "Not found." });
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        return sendJson(res, 400, { error: err.message });
      }
      return sendJson(res, 200, { ok: true });
    }

    // ── Finding people ──
    if (p === "/search" && method === "GET") {
      const query = String(url.searchParams.get("q") || "").trim().slice(0, 50);
      const people = query ? await store.searchPeople(user, query) : [];
      const nearby = query ? [] : await store.peopleNearby(user);
      if (url.searchParams.get("partial") === "1") return page(200, betaViews.searchResults({ query, people, nearby, formToken }));
      return page(200, betaViews.searchPage({ settings, user, formToken, query, people, nearby }), extraHeaders);
    }

    // ── Feedback ──
    if (p === "/feedback") {
      const from = (method === "GET" ? url.searchParams.get("from") : null) || "";
      const safeFrom = /^\/[A-Za-z0-9_\-/@.?=&%]*$/.test(from) && !from.startsWith("//") ? from : "";
      if (method === "GET") return page(200, betaViews.feedbackPage({ settings, user, formToken, from: safeFrom }), extraHeaders);
      const form = await readForm(req);
      const back = /^\/[A-Za-z0-9_\-/@.?=&%]*$/.test(form.from || "") && !String(form.from).startsWith("//") ? form.from : "";
      try {
        checkToken(form._token);
        if (!feedbackLimit(`feedback:${user.id}`)) throw new InputError("Thanks, that's a lot of feedback! Please wait a bit before sending more.");
        await store.addFeedback(user.id, { kind: form.kind, body: form.body, page: back, device: req.headers["user-agent"] });
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        return page(400, betaViews.feedbackPage({ settings, user, formToken, from: back, values: form, error: err.message }));
      }
      alertAdmins(`New feedback from @${user.username}: ${String(form.body).slice(0, 120)}`, { subject: "Radius feedback", link: "/admin/beta#feedback" });
      return page(200, betaViews.feedbackThanksPage({ settings, user, from: back }));
    }

    // ── Badges: what they are and how to earn them ──
    if (p === "/badges" && method === "GET" && settings.badges_enabled) {
      await badges(user.id);
      const mine = new Set((await store.badgesOf(user.id)).map((b) => b.badge));
      return page(200, postViews.badgesPage({ settings, user, badges: BADGES, mine }), extraHeaders);
    }

    // ── Today's recap ──
    if (p === "/today" && method === "GET" && settings.today_recap_enabled) {
      const here = user.feed_lat !== null ? places.nearestTown(user.feed_lat, user.feed_lon) : null;
      if (!here) return redirect(res, "/?tab=nearby");
      const posts = await store.nearbyFeed(user, { s: { ...settings, ripples_enabled: false }, when: { since: new Date(Date.now() - 86400000) }, limit: 9 });
      const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(new Date());
      return page(200, growthViews.todayPage({ settings, user, town: here, dateLabel, posts }), extraHeaders);
    }

    // ── My invite card ──
    if (p === "/invite" && method === "GET") {
      const invite = await store.memberInvite(user, settings.invites_per_member);
      const link = invite ? `${siteUrl}/join/${invite.code}` : null;
      const qrSvg = link ? await QRCode.toString(link, { type: "svg", margin: 1, color: { dark: "#1c1b33", light: "#ffffff" } }) : "";
      const spot = user.feed_lat !== null ? { lat: user.feed_lat, lon: user.feed_lon } : user.area_lat !== null ? { lat: user.area_lat, lon: user.area_lon } : null;
      const town = spot ? places.nearestTown(spot.lat, spot.lon) : user.area_name;
      const peopleNearby = spot ? await store.peopleNear(spot.lat, spot.lon, 10) : 0;
      return page(200, growthViews.invitePage({ settings, user, invite, link, qrSvg, peopleNearby, town }), extraHeaders);
    }

    // ── Around you: signals ──
    if (settings.signals_enabled && p === "/around" && method === "GET") {
      const kind = ["ask", "plan", "lost", "poll"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : null;
      return page(200, signalViews.aroundPage({ settings, user, formToken, signals: await store.signalsNear(user, { kind }), kind, timeZone }), extraHeaders);
    }
    if (settings.signals_enabled && p === "/around/new") {
      const kind = url.searchParams.get("kind") || "ask";
      if (method === "GET") return page(200, signalViews.newSignalPage({ settings, user, formToken, kind }), extraHeaders);
      const form = await readForm(req);
      try {
        checkToken(form._token);
        if ((await politics.check({ caption: form.body }, settings)).political) {
          throw new InputError("Around you is for local stuff, so it can't be political. You can still post it to your followers.");
        }
        const place = user.feed_lat !== null ? { lat: user.feed_lat, lon: user.feed_lon } : null;
        const signal = await store.createSignal(user.id, {
          kind: form.kind,
          body: form.body,
          planAt: form.plan_at_iso || zonedLocalToDate(form.plan_at, timeZone),
          options: [form.option0, form.option1, form.option2, form.option3],
          place,
          areaName: place ? places.nearestTown(place.lat, place.lon) : null,
        });
        return redirect(res, `/s/${signal.id}`);
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        return page(400, signalViews.newSignalPage({ settings, user, formToken, kind: form.kind, values: form, error: err.message }));
      }
    }
    // ── Pull Up: on my way / pulled up 👋 (posts with a place, and plans) ──
    m = p.match(/^\/(p|s)\/(\d{1,18})\/pullup(\/here|\/cancel|\/selfie)?$/);
    if (m && method === "POST" && featureOn(settings, "pullup", user)) {
      const target = m[1] === "p" ? await store.post(m[2], user.id) : settings.signals_enabled ? await store.signal(m[2], user.id) : null;
      const base = `/${m[1]}/${m[2]}`;
      const failed = (message) => page(400, views.messagePage({ settings, user, title: "Pull Up", message, extra: `<p><a href="${base}#pullup">Back</a></p>` }));
      if (!target || !pullUpOpen({ ...target, kind: m[1] === "p" ? "post" : "signal", signal_kind: target.kind })) return failed("You can't pull up to this one any more.");
      const t = { kind: m[1] === "p" ? "post" : "signal", id: target.id, user_id: target.user_id };
      try {
        if (m[3] === "/selfie") {
          checkToken(url.searchParams.get("_token"));
          const upload = await readUpload(req, "photo", MAX_PHOTO_BYTES);
          if (!upload || !upload.length) throw new InputError("Please choose a photo.");
          const image = await processImage(upload, "avatar");
          const verdict = await screener.screen(image.buffer, { strict: user.is_teen && settings.teen_strict_screening });
          if (verdict.action !== "allow") await refuse(user, "avatar", image, verdict);
          const key = newKey();
          await media.put(key, image.buffer, image.contentType);
          const old = await store.setPullUpPhoto(t, user.id, key).catch(async (err) => {
            await media.remove(key).catch(() => {});
            throw err;
          });
          if (old) await media.remove(old).catch(() => {});
          return redirect(res, `${base}#pullup`);
        }
        const form = await readForm(req);
        checkToken(form._token);
        if (!m[3]) await store.pullUp(t, user.id, "coming");
        else if (m[3] === "/cancel") await store.cancelPullUp(t, user.id);
        else {
          const lat = Number(form.lat);
          const lon = Number(form.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || form.lat === "" || form.lon === "") throw new InputError("We couldn't get your location. Please allow location access and try again.");
          if (milesBetween({ lat, lon }, { lat: target.lat, lon: target.lon }) > PULLUP_MILES) throw new InputError("You're not there yet. Tap “I'm here” once you've arrived.");
          await store.pullUp(t, user.id, "here");
          await together(settings, user.id);
        }
      } catch (err) {
        if (!(err instanceof InputError) && !(err instanceof ImageError)) throw err;
        return failed(err.message);
      }
      return redirect(res, `${base}#pullup`);
    }

    // ── Drops: photos and notes you have to go to ──
    if ((p === "/drops" || p.startsWith("/drops/")) && featureOn(settings, "drops", user)) {
      if (p === "/drops" && method === "GET") {
        const spot = user.feed_lat !== null ? { lat: user.feed_lat, lon: user.feed_lon } : null;
        return page(
          200,
          dropViews.dropsPage({ settings, user, formToken, notice, nearby: spot ? await store.dropsNear(user, { ...spot, miles: 5 }) : [], mine: await store.myDrops(user.id), stamps: await store.dropStamps(user.id) }),
          extraHeaders,
        );
      }
      if (p === "/drops/spots" && method === "GET") {
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return sendJson(res, 400, { error: "We couldn't get your location." });
        const found = await publicPlaces.near(lat, lon);
        if (!found) return sendJson(res, 503, { error: "We couldn't look up places right now. Please try again in a minute." });
        if (found.school) return sendJson(res, 200, { school: true, spots: [] });
        return sendJson(res, 200, { school: false, spots: found.spots.map((s) => ({ id: s.id, name: s.name, emoji: s.emoji, meters: s.meters })) });
      }
      if (p === "/drops/new" && method === "GET") return page(200, dropViews.newDropPage({ settings, user, formToken }), extraHeaders);
      if (p === "/drops/new" && method === "POST") {
        let key = null;
        try {
          checkToken(url.searchParams.get("_token"));
          const upload = await readMultipart(req, { field: "photo", maxFiles: 1, fileLimit: MAX_POST_PHOTO_BYTES });
          const fields = upload.fields;
          const found = await publicPlaces.near(Number(fields.lat), Number(fields.lon));
          if (!found) throw new InputError("We couldn't look up places right now. Please try again in a minute.");
          if (found.school) throw new InputError("Drops can't be left near a school.");
          const place = found.spots.find((s) => s.id === fields.spot);
          if (!place) throw new InputError("Pick one of the public places near you.");
          if (upload.files[0] && upload.files[0].length) {
            const image = await processImage(upload.files[0], "photo");
            const verdict = await screener.screen(image.buffer, { strict: user.is_teen && settings.teen_strict_screening });
            if (verdict.action !== "allow") await refuse(user, "upload", image, verdict);
            key = newKey();
            await media.put(key, image.buffer, image.contentType);
          }
          const drop = await store.createDrop(user.id, { place, note: fields.note, photoKey: key });
          return redirect(res, `/drops/${drop.id}`);
        } catch (err) {
          if (key) await media.remove(key).catch(() => {});
          if (!(err instanceof InputError) && !(err instanceof ImageError)) throw err;
          return page(400, dropViews.newDropPage({ settings, user, formToken, error: err.message }));
        }
      }
      const dm = p.match(/^\/drops\/(\d{1,18})(\/open|\/delete)?$/);
      if (dm) {
        const drop = await store.drop(dm[1], user.id);
        if (!drop) return page(404, views.messagePage({ settings, user, title: "Gone", message: "That Drop isn't there any more." }));
        if (!dm[2] && method === "GET") return page(200, dropViews.dropPage({ settings, user, formToken, drop }), extraHeaders);
        if (method === "POST") {
          const form = await readForm(req);
          checkToken(form._token);
          if (dm[2] === "/delete") {
            const old = await store.deleteDrop(drop.id, user.id);
            if (old) await media.remove(old).catch(() => {});
            return redirect(res, "/drops");
          }
          const here = { lat: Number(form.lat), lon: Number(form.lon) };
          if (form.lat === "" || form.lon === "" || !Number.isFinite(here.lat) || !Number.isFinite(here.lon)) {
            return page(400, dropViews.dropPage({ settings, user, formToken, drop, error: "We couldn't get your location. Please allow location access and try again." }));
          }
          const away = meters(here, drop);
          if (away > PLACE_METERS + 50) {
            const far = away < 1609 ? `${Math.round(away / 10) * 10} m` : `${(away / 1609.344).toFixed(1)} miles`;
            return page(400, dropViews.dropPage({ settings, user, formToken, drop, error: `Not quite there: you're about ${far} away.` }));
          }
          if (String(drop.user_id) !== String(user.id)) await store.findDrop(drop, user.id);
          return redirect(res, `/drops/${drop.id}`);
        }
      }
    }

    // ── Where It's At ──
    if (p === "/where" && method === "GET" && featureOn(settings, "heatmap", user)) {
      if (user.feed_lat === null) return redirect(res, "/hello");
      return page(200, dropViews.wherePage({ settings, user, lat: user.feed_lat, lon: user.feed_lon }), extraHeaders);
    }
    if (p === "/where/data" && method === "GET" && featureOn(settings, "heatmap", user)) {
      const spots = await store.heatSpots(user, { minPeople: settings.heat_min_people });
      return sendJson(
        res,
        200,
        spots.map((s) => ({ lat: s.lat, lon: s.lon, posts: s.posts, people: s.people, town: String(s.area_name || "").split(",")[0], shown: s.posts_shown.map((x) => ({ href: `/p/${x.id}`, thumb: `/${x.thumb}` })) })),
      );
    }

    // ── Squads ──
    if ((p === "/squads" || p.startsWith("/squads/")) && featureOn(settings, "squads", user)) {
      const info = weekInfo(timeZone);
      const streakOf = (weeks) => streakFrom(weeks || [], info.week);
      const listPage = async (status, error = null) => {
        const squads = await store.mySquads(user.id);
        const streaks = Object.fromEntries(squads.map((s) => [s.id, streakOf(s.weeks)]));
        return page(status, irlViews.squadsPage({ settings, user, formToken, squads, streaks, error, notice }), extraHeaders);
      };
      if (p === "/squads" && method === "GET") return listPage(200);
      if (p === "/squads/new" && method === "POST") {
        const form = await readForm(req);
        try {
          checkToken(form._token);
          const squad = await store.createSquad(user.id, form);
          return redirect(res, `/squads/${squad.id}`);
        } catch (err) {
          if (!(err instanceof InputError)) throw err;
          return listPage(400, err.message);
        }
      }
      const sm = p.match(/^\/squads\/(\d{1,18})(\/[a-z]+)?$/);
      if (sm) {
        const squad = await store.squadFor(sm[1], user.id);
        if (!squad) return page(404, views.messagePage({ settings, user, title: "Not found", message: "That squad isn't there, or you're not in it." }));
        const action = sm[2] || "";
        const member = squad.my_status === "member";
        const squadPage = async (status, error = null) =>
          page(
            status,
            irlViews.squadPage({
              settings,
              user,
              formToken,
              squad,
              members: await store.squadMembers(squad.id),
              messages: await store.squadMessages(squad.id, user.id),
              candidates: await store.squadCandidates(squad.id, user.id),
              streak: streakOf(squad.weeks),
              thisWeek: (await store.squadWeek(squad.id, info.week))?.reason || null,
              error,
            }),
            extraHeaders,
          );
        if (!action && method === "GET") return member ? squadPage(200) : redirect(res, "/squads");
        if (action === "/messages" && method === "GET" && member) {
          const after = Number.parseInt(url.searchParams.get("after"), 10) || 0;
          const rows = await store.squadMessages(squad.id, user.id, { after });
          return sendJson(res, 200, rows.map((r) => ({ id: r.id, name: r.display_name, body: r.body, mine: String(r.user_id) === String(user.id) })));
        }
        if (method === "POST") {
          const form = await readForm(req);
          try {
            checkToken(form._token);
            if (action === "/accept" || action === "/decline") {
              await store.answerSquadInvite(squad.id, user.id, action === "/accept");
              return redirect(res, action === "/accept" ? `/squads/${squad.id}` : "/squads");
            }
            if (action === "/leave") {
              await store.leaveSquad(squad.id, user.id);
              return redirect(res, "/squads");
            }
            if (!member) return redirect(res, "/squads");
            if (action === "/say") {
              const msg = await store.addSquadMessage(squad.id, user.id, form.body);
              if (wantsJson) return sendJson(res, 200, { id: msg.id });
              return redirect(res, `/squads/${squad.id}`);
            }
            if (action === "/invite") {
              await store.inviteToSquad(squad.id, user.id, form.username, { allowed: (who) => featureOn(settings, "squads", { is_teen: isTeen(who) }) });
              return redirect(res, `/squads/${squad.id}`);
            }
            if (action === "/remove") {
              await store.removeFromSquad(squad.id, user.id, form.user);
              return redirect(res, `/squads/${squad.id}`);
            }
          } catch (err) {
            if (!(err instanceof InputError)) throw err;
            if (wantsJson) return sendJson(res, 400, { error: err.message });
            return squadPage(400, err.message);
          }
        }
      }
    }

    m = p.match(/^\/s\/(\d{1,18})(\/.*)?$/);
    if (m && settings.signals_enabled) {
      const signal = await store.signal(m[1], user.id);
      if (!signal) return page(404, views.messagePage({ settings, user, title: "Gone", message: "That's not around any more." }));
      const action = m[2] || "";
      const signalPage = async (status, error = null) =>
        page(status, signalViews.signalPage({ settings, user, formToken, signal: (await store.signal(signal.id, user.id)) || signal, replies: await store.signalReplies(signal.id, user.id), timeZone, error, extra: await pullUpHtml({ ...signal, kind: "signal", signal_kind: signal.kind }) }));
      if (!action && method === "GET") return signalPage(200);
      if (method === "POST") {
        const form = await readForm(req);
        try {
          checkToken(form._token);
          if (action === "/reply") {
            await store.replyToSignal(signal, user.id, form.body);
            return redirect(res, `/s/${signal.id}#answers`);
          }
          const tm = action.match(/^\/thank\/(\d{1,18})$/);
          if (tm) {
            await store.thankReply(signal, tm[1], user.id);
            const thanked = (await store.signalReplies(signal.id, user.id)).find((r) => String(r.id) === tm[1]);
            if (thanked) await badges(thanked.user_id);
            return redirect(res, `/s/${signal.id}#answers`);
          }
          if (action === "/join") {
            const joined = await store.toggleJoin(signal, user.id);
            if (joined) await badges(signal.user_id);
            if (joined) await together(settings, user.id);
            if (wantsJson) return sendJson(res, 200, { joined, count: (await store.signal(signal.id, user.id)).join_count });
            return redirect(res, String(req.headers.referer || "").includes("/around") ? "/around" : `/s/${signal.id}`);
          }
          if (action === "/vote") {
            await store.vote(signal, user.id, form.choice);
            return redirect(res, String(req.headers.referer || "").includes("/around") ? "/around" : `/s/${signal.id}`);
          }
          if (action === "/delete") {
            await store.deleteSignal(signal.id, user.id);
            return redirect(res, "/around");
          }
        } catch (err) {
          if (!(err instanceof InputError)) throw err;
          return signalPage(400, err.message);
        }
      }
    }

    // ── A Moment ──
    m = p.match(/^\/m\/(\d{1,18})(\/reel|\/reel\.json)?$/);
    if (m) {
      const moment = await store.moment(m[1]);
      const posts = moment ? await store.postsByIds(await store.momentPostIds(moment.id, user.id), user.id) : [];
      if (!moment || !posts.length) return page(404, views.messagePage({ settings, user, title: "Not found", message: "That Moment isn't there any more." }));
      const reelsOn = featureOn(settings, "reels", user);
      if (m[2] === "/reel" && method === "POST" && reelsOn) {
        const form = await readForm(req);
        checkToken(form._token);
        await reelFor(moment, user.id);
        return redirect(res, `/m/${moment.id}#reel`);
      }
      if (m[2] === "/reel.json" && method === "GET" && reelsOn) {
        const reel = await reelFor(moment, user.id, { start: false });
        return sendJson(res, 200, { status: reel ? reel.status : "none" });
      }
      if (!m[2] && method === "GET") {
        const reel = reelsOn ? await reelFor(moment, user.id, { start: false }) : null;
        return page(200, postViews.momentPage({ settings, user, formToken, moment, posts, reel }), extraHeaders);
      }
    }
    m = p.match(/^\/@([A-Za-z0-9_.]{3,30})(\/follow|\/message|\/block|\/unblock)?$/);
    if (m) {
      const profile = await store.userByUsername(m[1]);
      const blocked = profile ? await store.blockBetween(user.id, profile.id) : null;
      // Someone who blocked you looks like they aren't here.
      const otherWorld = profile && !blocked && !(await store.canInteract(user.id, profile.id));
      const waiting = profile && profile.needs_parent_consent && !profile.parent_consent_at;
      if (!profile || !profile.username || profile.status !== "active" || blocked === "them" || otherWorld || waiting) {
        return page(404, views.messagePage({ settings, user, title: "Not found", message: "There's nobody here by that name." }));
      }
      if (m[2] && method === "POST") {
        const form = await readForm(req);
        checkToken(form._token);
        if (m[2] === "/block") {
          await store.block(user.id, profile.id);
          return redirect(res, `/@${profile.username}`);
        }
        if (m[2] === "/unblock") {
          await store.unblock(user.id, profile.id);
          return redirect(res, form.back === "/settings" ? "/settings#blocked" : `/@${profile.username}`);
        }
        if (m[2] === "/message") {
          // Teen mode: who teens can start chats with (Admin → Teen mode).
          if (user.is_teen && settings.teen_messages !== "requests") {
            const ok = settings.teen_messages === "mutual" ? await store.mutualFollow(user.id, profile.id) : await store.follows(profile.id, user.id);
            if (!ok) {
              const why = settings.teen_messages === "mutual" ? "You can message people you follow who follow you back." : "You can message people who follow you.";
              return page(400, views.messagePage({ settings, user, title: "Can't message yet", message: why, extra: `<p><a href="/@${profile.username}">Back to @${profile.username}</a></p>` }));
            }
          }
          return redirect(res, `/messages/${await store.conversationWith(user.id, profile.id)}`);
        }
        await store.toggleFollow(user.id, profile.id);
        const back = String(form.back || "");
        if (back.startsWith("/search") && /^\/search(\?q=[^\s<>"]*)?$/.test(back)) return redirect(res, back);
        return redirect(res, back.startsWith("/activity") ? "/activity" : `/@${profile.username}`);
      }
      if (!m[2] && method === "GET" && blocked === "me") {
        return page(200, safetyViews.blockedProfilePage({ settings, user, formToken, profile }), extraHeaders);
      }
      if (!m[2] && method === "GET") {
        if (String(profile.id) === String(user.id)) await badges(user.id);
        const rows = await store.profilePosts(profile.id, user.id, { page: pageNumber });
        profile.badges = settings.badges_enabled ? await store.badgesOf(profile.id) : [];
        const stats = await store.followStats(profile.id, user.id);
        return page(200, postViews.profilePage({ settings, user, formToken, profile, stats, page: pageNumber, posts: paged(rows, PAGE_SIZE * 3), squadsLink: featureOn(settings, "squads", user) }), extraHeaders);
      }
    }

    // ── Have they moved? ─────────────────────────────────────────────────
    // The page checks quietly (only if location is already allowed) and, if
    // they're now more than MOVED_MILES from their Nearby spot or their
    // profile's area, offers to update both.
    if (p === "/location/check" && method === "GET") {
      const place = roundLocation(url.searchParams.get("lat"), url.searchParams.get("lon"));
      if (!place) return sendJson(res, 400, { error: "No location." });
      const saved = [
        user.feed_lat !== null ? { lat: user.feed_lat, lon: user.feed_lon } : null,
        user.area_lat !== null && user.area_name ? { lat: user.area_lat, lon: user.area_lon } : null,
      ].filter(Boolean);
      const moved = saved.length > 0 && saved.some((spot) => milesBetween(spot, place) > MOVED_MILES);
      return sendJson(res, 200, { moved, town: moved ? places.nearestTown(place.lat, place.lon) : null });
    }
    if (p === "/location/update" && method === "POST") {
      const form = await readForm(req);
      checkToken(form._token);
      const place = roundLocation(form.lat, form.lon);
      if (!place) return sendJson(res, 400, { error: "We couldn't get your location." });
      await store.setFeedLocation(user.id, place);
      if (user.area_name) {
        const town = places.nearestTown(place.lat, place.lon);
        if (town) await store.setArea(user.id, place, town);
      }
      return sendJson(res, 200, { ok: true });
    }

    // ── The Nearby feed's location and distance ──────────────────────────
    if ((p === "/feed/location" || p === "/feed/radius") && method === "POST") {
      const form = await readForm(req);
      try {
        checkToken(form._token);
        if (p === "/feed/radius") await store.setFeedRadius(user.id, form.miles, { min: user.min_radius });
        else {
          const place = roundLocation(form.lat, form.lon);
          if (!place) throw new InputError("We couldn't get your location. Please allow location access and try again.");
          await store.setFeedLocation(user.id, place);
          if (form.back === "/hello") return redirect(res, "/hello");
        }
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        const rows = await store.nearbyFeed(user);
        return page(400, postViews.feedPage({ settings, user, formToken, tab: "nearby", page: 0, posts: paged(rows, PAGE_SIZE), error: err.message }));
      }
      return redirect(res, "/?tab=nearby");
    }

    // ── New posts ────────────────────────────────────────────────────────
    if (p === "/new" && method === "GET") return page(200, postViews.newPostPage({ settings, user, formToken, videos: featureOn(settings, "reels", user) }), extraHeaders);
    if (p === "/new" && method === "POST") {
      const stored = [];
      let fields = {};
      try {
        checkToken(url.searchParams.get("_token"));
        const videosOn = featureOn(settings, "reels", user);
        const upload = await readMultipart(req, { field: "photos", maxFiles: MAX_PHOTOS, fileLimit: videosOn ? MAX_VIDEO_BYTES : MAX_POST_PHOTO_BYTES, withHeads: true });
        fields = upload.fields;
        if (!upload.files.length) throw new InputError("Please add at least one photo.");
        const photos = [];
        let held = false;
        const labels = [];
        const found = { text: [], people: [] };
        // Only posts with a place can be on Nearby, so only they need a political check.
        const checkPolitics = settings.nearby_politics_filter && fields.with_location === "on";
        const strict = user.is_teen && settings.teen_strict_screening;
        for (const file of upload.files) {
          // A video clip: made silent and small, and every second of it screened like a photo.
          let clip = null;
          if (isVideo(file)) {
            if (!videosOn) throw new InputError("Video clips aren't available yet. Please share photos.");
            clip = await processClip(file);
            for (const frame of clip.frames) {
              const v = await screener.screen(frame, { strict });
              if (v.action === "refuse") await refuse(user, "upload", await processImage(frame, "photo"), v);
              if (v.action === "hold") held = true;
              labels.push(...v.labels);
            }
          } else if (file.length > MAX_POST_PHOTO_BYTES) {
            throw new InputError(`That photo is too big (the limit is ${Math.round(MAX_POST_PHOTO_BYTES / 1024 / 1024)} MB).`);
          }
          const still = clip ? clip.poster : file;
          const full = await processImage(still, "photo");
          if (!clip) {
            const verdict = await screener.screen(full.buffer, { strict });
            if (verdict.action === "refuse") await refuse(user, "upload", full, verdict);
            if (verdict.action === "hold") held = true;
            labels.push(...verdict.labels);
          }
          if (checkPolitics) {
            const seen = await screener.inspect(full.buffer);
            if (seen.text) found.text.push(seen.text);
            found.people.push(...seen.people);
          }
          const thumb = await processImage(still, "thumb");
          const photo = { photoKey: newKey(), thumbKey: newKey(), width: full.width, height: full.height };
          if (clip) {
            photo.videoKey = newKey("media", "mp4");
            await media.put(photo.videoKey, clip.video, "video/mp4");
            stored.push(photo.videoKey);
          }
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
        // Real photos: AI-made ones stay off Nearby; recent ones taken right here get the badge.
        let aiReason = null;
        let takenHere = Boolean(place) && settings.taken_here_badge;
        for (const [i, file] of upload.files.entries()) {
          if (isVideo(file)) {
            takenHere = false;
            continue;
          }
          const seen = await checkPhoto(upload.heads[i] || file, { place, hours: settings.taken_here_hours, miles: settings.taken_here_miles });
          if (seen.aiMarker && !aiReason) aiReason = `The photo says it was made with AI (${seen.aiMarker})`;
          if (!seen.takenHere) takenHere = false;
        }
        const imageText = found.text.join("\n");
        const nearby = place ? await politics.check({ caption: fields.caption, imageText, people: found.people }, settings) : { political: false, reason: null };
        const post = await store.createPost(user.id, { caption: fields.caption, photos, place, areaName, held, labels, imageText, imagePeople: found.people, nearby, aiReason, takenHere });
        if (held) alertAdmins(`A post from @${user.username} is waiting for review (photo screening).`);
        // Moments: shared albums that make themselves.
        if (!held && place) {
          const joined = await store.attachToMoment(post, settings, { timeZone });
          if (joined) {
            await store.notifyMoment(joined.moment.id, joined.posterIds);
            for (const uid of joined.posterIds) await badges(uid);
          }
        }
        await badges(user.id);
        if (!held && place) await together(settings, user.id);
        if (wantsJson) return sendJson(res, 200, { location: `/p/${post.id}` });
        return redirect(res, `/p/${post.id}`);
      } catch (err) {
        for (const key of stored) await media.remove(key).catch(() => {});
        if (!(err instanceof InputError) && !(err instanceof ImageError)) throw err;
        if (wantsJson) return sendJson(res, 400, { error: err.message });
        return page(400, postViews.newPostPage({ settings, user, formToken, error: err.message, caption: fields.caption, videos: featureOn(settings, "reels", user) }));
      }
    }

    // ── A post: likes, comments, editing ─────────────────────────────────
    m = p.match(/^\/p\/(\d{1,18})(\/.*)?$/);
    if (m) {
      const post = await store.post(m[1], user.id);
      if (!post) return page(404, views.messagePage({ settings, user, title: "Not found", message: "That post isn't there any more." }));
      const action = m[2] || "";
      /** Tells the poster when a like or comment carries their post to a new ring. */
      const rippled = async (p0, before, after) => {
        if (p0.lat === null || !settings.ripples_enabled || String(p0.user_id) === String(user.id)) return;
        const [was, now] = [reachMiles(before, settings), reachMiles(after, settings)];
        if (now > was) {
          await store.notifyRipple(p0, now);
          await badges(p0.user_id);
        }
      };
      const postPage = async (status, error = null) =>
        page(status, postViews.postPage({ settings, user, formToken, post: (await store.post(post.id, user.id)) || post, comments: await store.comments(post.id, user.id), moment: await store.momentOfPost(post.id), error, extra: await pullUpHtml({ ...post, kind: "post" }) }));
      if (!action && method === "GET") return postPage(200);
      if (method === "POST") {
        const form = await readForm(req);
        try {
          checkToken(form._token);
          if (action === "/like") {
            const result = await store.toggleLike(post.id, user.id);
            if (result.liked) await rippled(post, result.count - 1 + post.comment_count, result.count + post.comment_count);
            if (wantsJson) return sendJson(res, 200, result);
            return redirect(res, String(req.headers.referer || "").startsWith(siteOrigin) ? new URL(req.headers.referer).pathname + new URL(req.headers.referer).search : `/p/${post.id}`);
          }
          if (action === "/comments") {
            const comment = await store.addComment(post.id, user.id, form.body);
            await rippled(post, post.like_count + post.comment_count, post.like_count + post.comment_count + 1);
            return redirect(res, `/p/${post.id}#c${comment.id}`);
          }
          const cm = action.match(/^\/comments\/(\d{1,18})\/delete$/);
          if (cm) {
            await store.deleteComment(cm[1], user.id);
            return redirect(res, `/p/${post.id}#comments`);
          }
          if (action === "/caption") {
            await store.updateCaption(post.id, user.id, form.caption);
            if (post.lat !== null) {
              const fresh = await store.postForModeration(post.id);
              await store.setNearby(post.id, await politics.check({ caption: fresh.caption, imageText: fresh.image_text, people: fresh.image_people }, settings));
            }
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
      // No phone notifications yet: offer them at the top (Activity is where people look for them).
      const prompt = (await store.pushDeviceCount(user.id)) ? "" : firstLookViews.pushCard({ publicKey: push.publicKey, compact: true });
      return page(200, messageViews.activityPage({ settings, user, formToken, items, seenAt, prompt }), extraHeaders);
    }

    // ── Messages ─────────────────────────────────────────────────────────
    if ((p === "/messages" || p === "/messages/requests") && method === "GET") {
      const requestsPage = p === "/messages/requests";
      const conversations = await store.inbox(user.id, { requests: requestsPage });
      const requests = requestsPage ? 0 : (await store.inbox(user.id, { requests: true })).length;
      return page(200, messageViews.inboxPage({ settings, user, conversations, requests, requestsPage, notice, squadsLink: featureOn(settings, "squads", user) }), extraHeaders);
    }
    m = p.match(/^\/messages\/(\d{1,18})(\/.*)?$/);
    if (m) {
      const conversation = await store.conversation(m[1], user.id);
      if (!conversation) return page(404, views.messagePage({ settings, user, title: "Not found", message: "That chat isn't there any more." }));
      const action = m[2] || "";
      // Teen mode: view-once photos only as Admin → Teen mode allows.
      conversation.photos_off =
        user.is_teen && (settings.teen_photos === "off" || (settings.teen_photos === "mutual" && !(await store.mutualFollow(user.id, conversation.other_id))));
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
          if (conversation.photos_off) throw new InputError("Photos can only be sent to people you follow who follow you back.");
          const upload = await readUpload(req, "photo", MAX_POST_PHOTO_BYTES);
          if (!upload || !upload.length) throw new InputError("Please choose a photo.");
          const image = await processImage(upload, "photo");
          const verdict = await screener.screen(image.buffer, { strict: user.is_teen && settings.teen_strict_screening });
          if (verdict.action !== "allow") await refuse(user, "snap", image, verdict);
          key = newKey();
          await media.put(key, image.buffer, image.contentType);
          await store.sendSnap(conversation, user.id, key);
          store.countEvent("message", dayIn(timeZone)).catch(() => {});
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
            store.countEvent("message", dayIn(timeZone)).catch(() => {});
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
            for (const key of await store.unsend(conversation, um[1], user.id)) await media.remove(key).catch(() => {});
            return redirect(res, `/messages/${conversation.id}`);
          }
          const sm = action.match(/^\/snaps\/(\d{1,18})$/);
          if (sm) {
            // View once: the photo is taken out of the message, shown, then deleted.
            const key = await store.openSnap(conversation, sm[1], user.id);
            if (!key) throw new InputError("That photo has already been opened.");
            const body = await media.get(key);
            // Kept for a short while so it can be reported, then deleted.
            await store.keepOpenedSnap(sm[1], key);
            if (!body) throw new InputError("That photo isn't there any more.");
            const counts = await store.messageCounts(user.id);
            user.badges.messages = counts.unread + counts.requests;
            return page(200, messageViews.snapPage({ settings, user, conversation, messageId: sm[1], image: { buffer: body, contentType: "image/webp" } }));
          }
        } catch (err) {
          if (!(err instanceof InputError)) throw err;
          return chatPage(400, err.message);
        }
      }
    }

    // ── Reporting ────────────────────────────────────────────────────────
    // /report?type=post&id=…, comment&id=…, user&id=<username>, message&c=<chat>&id=…
    if (p === "/report") {
      const params = method === "POST" ? await readForm(req) : Object.fromEntries(url.searchParams);
      const type = params.type;
      let target = null;
      let what = "";
      if (type === "post") {
        const post = await store.post(params.id, user.id);
        if (post) target = { type, userId: post.user_id, postId: post.id };
        what = post ? `@${post.username}'s post` : "";
      } else if (type === "comment") {
        const comment = /^\d{1,18}$/.test(String(params.id)) ? await store.commentForModeration(params.id) : null;
        if (comment && comment.status === "visible") target = { type, userId: comment.user_id, postId: comment.post_id, commentId: comment.id, snapshotText: comment.body };
        what = comment ? `@${comment.username}'s comment` : "";
      } else if (type === "signal") {
        const signal = await store.signal(params.id, user.id);
        if (signal && String(signal.user_id) !== String(user.id)) target = { type, userId: signal.user_id, signalId: signal.id, snapshotText: signal.body };
        what = signal ? `@${signal.username}'s ${signal.kind === "ask" ? "question" : signal.kind === "plan" ? "plan" : signal.kind === "lost" ? "lost & found" : "poll"}` : "";
      } else if (type === "user") {
        const someone = await store.userByUsername(params.id);
        if (someone && someone.username && String(someone.id) !== String(user.id)) target = { type, userId: someone.id };
        what = someone ? `@${someone.username}` : "";
      } else if (type === "message") {
        const conversation = await store.conversation(params.c, user.id);
        const message = conversation ? await store.message(conversation, params.id) : null;
        if (message && String(message.sender_id) !== String(user.id)) {
          target = { type, userId: message.sender_id, messageId: message.id, snapshotText: message.body, snapKey: message.report_key, conversationId: conversation.id };
          what = message.kind === "snap" ? `a photo from @${conversation.other_username}` : `a message from @${conversation.other_username}`;
        }
      }
      if (!target) return page(404, views.messagePage({ settings, user, title: "Not found", message: "That isn't there any more, so it can't be reported." }));
      const reportPage = (status, error = null) => page(status, safetyViews.reportPage({ settings, user, formToken, params, what, reasons: REASONS, error }));
      if (method === "GET") return reportPage(200);
      try {
        checkToken(params._token);
        if (target.snapKey) {
          if (type === "message" && !(await media.get(target.snapKey))) throw new InputError("That photo has already been deleted, so it can't be reported.");
          target.snapshotKey = await keepCopy(target.snapKey);
        }
        const { report } = await store.report(user.id, target, { reason: params.reason, details: params.details });
        if (report) alertAdmins(`New report: ${what} (${REASONS[params.reason]}).`, { urgent: params.reason === "minor" });
        if (params.block === "on") await store.block(user.id, target.userId);
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        return reportPage(400, err.message);
      }
      return page(200, safetyViews.reportedPage({ settings, user, blocked: params.block === "on", minor: params.reason === "minor", back: target.conversationId ? `/messages/${target.conversationId}` : target.postId ? "/" : "/" }));
    }

    // ── Settings ─────────────────────────────────────────────────────────
    const settingsPage = async (status, error = null) =>
      page(status, views.settingsPage({ settings, user, formToken, error, notice, blockedList: await store.blockedList(user.id), pushHtml: firstLookViews.pushCard({ publicKey: push.publicKey }) }));
    if (p === "/settings" && method === "GET") return settingsPage(200);
    if (p === "/settings/photo" && method === "POST") {
      try {
        checkToken(url.searchParams.get("_token"));
        const upload = await readUpload(req, "photo", MAX_PHOTO_BYTES);
        if (!upload || !upload.length) throw new InputError("Please choose a photo.");
        const image = await processImage(upload, "avatar");
        const verdict = await screener.screen(image.buffer, { strict: user.is_teen && settings.teen_strict_screening });
        if (verdict.action !== "allow") await refuse(user, "avatar", image, verdict);
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
        if (p === "/settings/emails") {
          await store.setEmailNudges(user.id, form.on === "on");
          return back("/settings", form.on === "on" ? "emailsOn" : "emailsOff");
        }
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
      return page(
        200,
        adminViews.overview({
          settings,
          admin,
          counts: await store.userCounts(),
          moderation: await store.moderationCounts(),
          notice,
          foundingHtml: foundingViews.foundingCard({ settings, admin, founding: await store.foundingStatus(settings), waiting: await store.waitlistCount(), siteUrl }),
        }),
      );
    }
    if (p === "/admin/founding" && method === "POST") {
      await store.setFounding(form);
      return back("/admin", "saved");
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
      page(
        status,
        adminViews.invites({
          settings,
          admin,
          siteUrl,
          timeZone,
          notice,
          error,
          list: await store.invites(),
          waitlistHtml: foundingViews.waitlistCard({ admin, list: await store.waitlist(), timeZone }),
        }),
      );
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
    m = p.match(/^\/admin\/waitlist\/(\d+)\/invite$/);
    if (m && method === "POST") {
      const entry = await store.waitlistEntry(m[1]);
      if (entry && !entry.invited_at) {
        const invite = await store.createInvite({ note: `Waitlist: ${entry.email}`, max_uses: 1 });
        const link = `${siteUrl}/join/${invite.code}`;
        await sendEmail({
          to: entry.email,
          subject: `You're in: your invite to ${settings.site_name}`,
          text: `A spot opened up on ${settings.site_name}. Here's your invite:\n\n${link}\n\nOr use the code ${invite.code} when you join.\n`,
          html: `<p>A spot opened up on ${settings.site_name}. Here's your invite:</p><p><a href="${link}">Join ${settings.site_name}</a></p><p>Or use the code <strong>${invite.code}</strong> when you join.</p>`,
        });
        await store.markWaitlistInvited(entry.id, invite.id);
      }
      return back("/admin/invites", "invite");
    }
    m = p.match(/^\/admin\/invites\/(\d+)\/revoke$/);
    if (m && method === "POST") {
      await store.revokeInvite(Number(m[1]));
      return back("/admin/invites", "revoked");
    }

    // ── Moderation ───────────────────────────────────────────────────────
    if (p === "/admin/moderation" && method === "GET") {
      return page(200, safetyViews.queuePage({ settings, admin, notice, reports: await store.openReports(), held: await store.heldPosts(), reasons: REASONS, timeZone }));
    }
    // Photos for the admin pages: live ones (held posts) and copies in the store.
    if (p.startsWith("/admin/media/") && method === "GET") {
      const key = p.slice("/admin/media/".length);
      const allowed = KEY.test(key) || (MODERATED_KEY.test(key) && (await store.moderatedKeyViewable(key)));
      const body = allowed ? await media.get(key) : null;
      if (!body) return text(res, 404, "Not found.");
      res.writeHead(200, { "content-type": "image/webp", "cache-control": "private, no-store", ...SECURITY_HEADERS });
      return res.end(body);
    }
    /** Takes a post down: photos copied to the store with the labels and report reasons. */
    async function takeDownPost(post, decision, note = "") {
      const reasons = await store.reasonsFor("post_id", post.id);
      const copies = [];
      for (const key of post.photo_keys || []) {
        const copy = await keepCopy(key);
        if (copy) copies.push(copy);
      }
      await store.addModerated({ source: "post", userId: post.user_id, username: post.username, body: post.caption, mediaKeys: copies, labels: post.screen_labels, reasons, decision, note });
      await store.setPostStatus(post.id, "removed");
      for (const key of [...(post.photo_keys || []), ...(post.thumb_keys || [])]) await media.remove(key).catch(() => {});
      await store.resolveReports(["post_id", post.id], decision === "legal_hold" ? "legal hold" : "removed");
    }
    m = p.match(/^\/admin\/moderation\/(post|comment|report)\/(\d{1,18})\/(remove|keep|legal-hold|dismiss|ban|off-nearby)$/);
    if (m && method === "POST") {
      const [, kind, id, action] = m;
      let doneKey = "moderated";
      if (kind === "post") {
        const post = await store.postForModeration(id);
        if (!post) return text(res, 404, "Not found.");
        if (action === "keep") {
          await store.setPostStatus(post.id, "visible");
          await store.resolveReports(["post_id", post.id], "kept");
        } else if (action === "off-nearby") {
          // Stays up for followers, just not on Nearby (like an AI-made photo).
          await store.setPostStatus(post.id, "visible");
          await store.setAiMade(post.id, form.note || "Kept off Nearby by the owner");
          await store.resolveReports(["post_id", post.id], "kept off Nearby");
        } else if (action === "remove" || action === "legal-hold") {
          await takeDownPost(post, action === "legal-hold" ? "legal_hold" : "removed", form.note);
          if (action === "legal-hold" || form.ban === "on") await store.ban(post.user_id, action === "legal-hold" ? "Child safety (legal hold)" : form.note || "Removed post");
          doneKey = action === "legal-hold" ? "legalHold" : "moderated";
        }
      } else if (kind === "comment") {
        const comment = await store.commentForModeration(id);
        if (!comment) return text(res, 404, "Not found.");
        if (action === "keep") {
          await store.setCommentStatus(comment.id, "visible");
          await store.resolveReports(["comment_id", comment.id], "kept");
        } else if (action === "remove" || action === "legal-hold") {
          const reasons = await store.reasonsFor("comment_id", comment.id);
          const decision = action === "legal-hold" ? "legal_hold" : "removed";
          await store.addModerated({ source: "comment", userId: comment.user_id, username: comment.username, body: comment.body, reasons, decision, note: form.note });
          await store.setCommentStatus(comment.id, "removed");
          await store.resolveReports(["comment_id", comment.id], decision === "legal_hold" ? "legal hold" : "removed");
          if (action === "legal-hold" || form.ban === "on") await store.ban(comment.user_id, action === "legal-hold" ? "Child safety (legal hold)" : form.note || "Removed comment");
        }
      } else {
        // A report about a person or a message.
        const report = await store.report1(id);
        if (!report || report.status !== "open") return back("/admin/moderation", "moderated");
        if (action === "dismiss") await store.resolveReport(report.id, "dismissed");
        if (action === "remove" || action === "legal-hold") {
          const decision = action === "legal-hold" ? "legal_hold" : "removed";
          const author = await store.user(report.user_id);
          if (report.signal_id) await store.removeSignal(report.signal_id);
          await store.addModerated({
            source: report.signal_id ? "signal" : report.snapshot_key ? "snap" : "message",
            userId: report.user_id,
            username: author?.username,
            body: report.snapshot_text || "",
            mediaKeys: report.snapshot_key ? [report.snapshot_key] : [],
            reasons: [report.reason],
            decision,
            note: form.note,
          });
          await store.resolveReport(report.id, decision === "legal_hold" ? "legal hold" : "removed");
        }
        if (action === "ban" || action === "legal-hold" || form.ban === "on") {
          await store.ban(report.user_id, action === "legal-hold" ? "Child safety (legal hold)" : form.note || `Reported: ${REASONS[report.reason]}`);
          if (action === "ban") await store.resolveReport(report.id, "banned");
        }
        if (action === "legal-hold") doneKey = "legalHold";
      }
      return back("/admin/moderation", doneKey);
    }
    // ── Nearby rules (politics stays off Nearby) ──
    if (p === "/admin/nearby" && method === "GET") {
      return page(200, safetyViews.nearbyRulesPage({ settings, admin, notice, posts: await store.offNearby(), timeZone }));
    }
    if (p === "/admin/nearby" && method === "POST") {
      await store.setNearbyRules(form);
      // Re-check the last month's posts with the new rules.
      const fresh = await store.settings();
      for (const post of await store.recentPlacedPosts(30)) {
        await store.setNearby(post.id, await politics.check({ caption: post.caption, imageText: post.image_text, people: post.image_people }, fresh));
      }
      return back("/admin/nearby", "saved");
    }
    m = p.match(/^\/admin\/nearby\/(\d{1,18})\/(show|hide)$/);
    if (m && method === "POST") {
      await store.setNearbyOverride(m[1], m[2] === "show");
      return back("/admin/nearby", "saved");
    }
    if (p === "/admin/teens" && method === "GET") {
      return page(200, teenViews.adminTeenPage({ settings, admin, notice, counts: await store.teenCounts() }));
    }
    if (p === "/admin/teens" && method === "POST") {
      await store.setTeenSettings(form);
      return back("/admin/teens", "saved");
    }
    if (p === "/admin/features" && method === "GET") return page(200, firstLookViews.featuresPage({ settings, admin, notice }));
    if (p === "/admin/features" && method === "POST") {
      await store.setFeatures(form);
      return back("/admin/features", "saved");
    }
    if (p === "/admin/beta" && method === "GET") {
      const showDone = url.searchParams.get("show") === "done";
      return page(
        200,
        betaViews.betaPage({ settings, admin, stats: await store.betaStats(timeZone), feedback: await store.feedbackList({ done: showDone }), showDone, timeZone, notice, sources: await store.signupSources() }),
      );
    }
    if (p === "/admin/beta/emails" && method === "POST") {
      await store.setSetting("email_nudges_enabled", form.on === "true" ? "true" : "false");
      return back("/admin/beta", "saved");
    }
    m = p.match(/^\/admin\/beta\/feedback\/(\d{1,18})\/(done|reopen)$/);
    if (m && method === "POST") {
      await store.setFeedbackDone(m[1], m[2] === "done");
      return redirect(res, "/admin/beta#feedback");
    }
    if (p === "/admin/removed" && method === "GET") {
      const decision = ["removed", "refused", "legal_hold"].includes(url.searchParams.get("show")) ? url.searchParams.get("show") : null;
      return page(200, safetyViews.storePage({ settings, admin, items: await store.moderatedItems({ decision }), decision, reasons: REASONS, timeZone }));
    }
    return text(res, 404, "Not found.");
  }

  const handler = async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (err instanceof InputError) return text(res, 400, err.message);
      log.error(err);
      if (!res.headersSent) text(res, 500, "Something went wrong. Please try again.");
    }
  };
  // Email nudges, run every few minutes by server.js.
  handler.runNudges = () => nudges.run();
  // Phone notifications, run every few seconds by server.js.
  handler.runPush = () => push.run();
  // Moment Reels: when a Moment has ended, make each poster's reel and tell them.
  handler.runReels = async () => {
    const settings = await store.settings();
    if (settings.features.reels === "off") return;
    for (const m of await store.momentsWaitingForReels({ minPosts: REEL_MIN_POSTS })) {
      const moment = await store.moment(m.id);
      for (const uid of m.user_ids) {
        const person = await store.user(uid);
        if (!person || person.status !== "active" || !featureOn(settings, "reels", { is_teen: isTeen(person) })) continue;
        const reel = await reelFor(moment, uid, { wait: true });
        if (reel && reel.status === "ready") await store.notifyReel(uid, moment.id);
      }
    }
  };
  // Squads: tidy old chat, and on weekends remind squads whose streak is about to end.
  handler.runSquads = async () => {
    await store.purgeSquadMessages();
    const settings = await store.settings();
    if (settings.features.squads === "off") return;
    const info = weekInfo(timeZone);
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(new Date())) % 24;
    if ((info.weekday === "Sat" && hour >= 10) || info.weekday === "Sun") await store.claimStreakReminders(info.week, info.lastWeek);
  };
  return handler;
}

module.exports = { createApp, clientIp };
