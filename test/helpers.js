// Shared test setup: a fresh database, a running copy of the site, captured
// emails, photos in a temporary folder, and a pretend browser with cookies.
//
// Needs PostgreSQL in DATABASE_URL (default: a local one on port 55432).
// Everything in it is wiped at the start of each test file.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const sharp = require("sharp");
const { migrate } = require("../lib/db");
const { createStore } = require("../lib/store");
const { createSessions } = require("../lib/sessions");
const { createDirStore } = require("../lib/media");
const { createPlaces } = require("../lib/places");
const { createApp } = require("../lib/app");

const OWNER = "owner@example.com";
const SITE_URL = "https://social.example.test";
const SECRET = "test-secret-that-is-long-enough-0123456789";
const quiet = { log: () => {}, error: () => {}, warn: () => {} };

// A few real towns, so the tests don't load all 135,000.
const TOWNS = [
  { name: "Springfield", adminCode: "MO", country: "US", population: 166810, loc: { coordinates: [-93.29824, 37.21533] } },
  { name: "Nixa", adminCode: "MO", country: "US", population: 23257, loc: { coordinates: [-93.29435, 37.04339] } },
  { name: "Toronto", adminCode: "08", country: "CA", population: 2600000, loc: { coordinates: [-79.39864, 43.70643] } },
];

async function startApp() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:55432/social_test" });
  await pool.query("drop schema public cascade; create schema public;");
  await migrate(pool, { log: () => {} });
  const store = createStore(pool);
  const emails = [];
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "social-media-"));
  const media = createDirStore(mediaDir);
  const handler = createApp({
    store,
    sessions: createSessions(SECRET),
    sendEmail: async (e) => emails.push(e),
    media,
    places: createPlaces(TOWNS),
    auth: { signedInUser: async (req) => (req.headers["x-test-admin"] ? { email: req.headers["x-test-admin"] } : null) },
    admins: [OWNER],
    secret: SECRET,
    siteUrl: SITE_URL,
    log: quiet,
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    store,
    base,
    emails,
    media,
    mediaDir,
    browser: () => browser(base),
    async stop() {
      await new Promise((r) => server.close(r));
      await pool.end();
      fs.rmSync(mediaDir, { recursive: true, force: true });
    },
  };
}

/** A pretend browser: keeps cookies, and can fill in forms from the last page. */
function browser(base) {
  const jar = new Map();
  const b = {
    last: null,
    async request(pathname, { form, body, headers = {}, method } = {}) {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await fetch(base + pathname, {
        method: method || (form || body ? "POST" : "GET"),
        redirect: "manual",
        headers: {
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: form ? new URLSearchParams(form).toString() : body,
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
        if (/Max-Age=0/.test(c)) jar.delete(k);
        else jar.set(k, v);
      }
      const isText = /text|json/.test(res.headers.get("content-type") || "");
      b.last = { status: res.status, location: res.headers.get("location"), headers: res.headers, body: isText ? await res.text() : Buffer.from(await res.arrayBuffer()) };
      return b.last;
    },
    get: (p, opts) => b.request(p, opts),
    /** The form token on the last page. */
    token() {
      return b.last.body.match(/name="_token" value="([^"]+)"/)[1];
    },
    /** POST a form with the last page's token. */
    post(p, form = {}) {
      return b.request(p, { form: { _token: b.token(), ...form } });
    },
    cookies: jar,
  };
  return b;
}

/** Signs `email` in through the real pages (code from the captured email). */
async function signIn(app, b, email) {
  await b.get("/sign-in");
  await b.post("/sign-in", { email });
  const code = app.emails.at(-1).subject.match(/^(\d{6})/)[1];
  await b.post("/sign-in/code", { email, code });
  return b.last;
}

/** Signs in and finishes joining (creating an invite if needed). */
async function join(app, email, username, extra = {}) {
  const b = app.browser();
  await signIn(app, b, email);
  const invite = await app.store.createInvite({ note: "test" });
  await b.get("/welcome");
  await b.post("/welcome", { invite: invite.code, birth_date: "1990-05-01", username, display_name: username, terms: "on", ...extra });
  return b;
}

/** A photo with GPS data in it, like a phone's. */
function phonePhoto({ width = 2000, height = 1500 } = {}) {
  return sharp({ create: { width, height, channels: 3, background: "#4a7" } })
    .jpeg()
    .withMetadata({ exif: { IFD3: { GPSLatitudeRef: "N", GPSLatitude: "37/1 12/1 55/1" } } })
    .toBuffer();
}

/** A multipart/form-data body with one file. */
function multipart(field, filename, buffer, type = "image/jpeg") {
  const boundary = "----test" + Date.now();
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, buffer, tail]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

module.exports = { startApp, signIn, join, phonePhoto, multipart, OWNER, SITE_URL };
