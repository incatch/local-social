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

// Pretend photo screening: pure red photos are "explicit" (refused), pure
// blue ones "violent" (held for review), everything else is fine.
const testScreener = {
  async screen(image) {
    const { channels } = await sharp(image).stats();
    const [r, g, b] = channels.map((c) => c.mean);
    if (r > 200 && g < 60 && b < 60) return { action: "refuse", labels: [{ name: "Explicit Nudity", parent: "", confidence: 99 }] };
    if (b > 200 && r < 60 && g < 60) return { action: "hold", labels: [{ name: "Graphic Violence", parent: "Violence", confidence: 88 }] };
    return { action: "allow", labels: [] };
  },
  // Pretend photo reading: yellow photos say "VOTE BIDEN 2028"; magenta ones
  // show a (pretend) senator.
  async inspect(image) {
    const { channels } = await sharp(image).stats();
    const [r, g, b] = channels.map((c) => c.mean);
    if (r > 200 && g > 200 && b < 60) return { text: "VOTE BIDEN 2028", people: [] };
    if (r > 200 && b > 200 && g < 60) return { text: "", people: [{ name: "Jane Senator", wikidataId: "Q999001" }] };
    return { text: "", people: [] };
  },
};
// Pretend OpenStreetMap (Overpass): a park and a café in downtown Springfield,
// and a school near 37.1900,-93.2800. Calls are counted (they should be cached).
const OVERPASS_PLACES = [
  { type: "way", id: 1, center: { lat: 37.2089, lon: -93.2925 }, tags: { leisure: "park", name: "Park Central Square" } },
  { type: "node", id: 2, lat: 37.2093, lon: -93.2919, tags: { amenity: "cafe", name: "Classic Rock Coffee" } },
  { type: "node", id: 3, lat: 37.2095, lon: -93.2921, tags: { amenity: "bar", name: "Not a place for Drops" } },
  { type: "way", id: 4, center: { lat: 37.1901, lon: -93.2801 }, tags: { amenity: "school", name: "Pretend Middle School" } },
  { type: "node", id: 5, lat: 37.1903, lon: -93.2803, tags: { leisure: "playground", name: "School Playground" } },
];
const overpassCalls = { n: 0 };
// Pretend Wikidata: Q999001 is a politician, anyone else isn't.
const testFetch = async (url) => {
  if (String(url).includes("overpass")) {
    overpassCalls.n += 1;
    return { ok: true, json: async () => ({ elements: OVERPASS_PLACES }) };
  }
  return wikidata(url);
};
const wikidata = async (url) => ({
  ok: true,
  json: async () => {
    const id = url.match(/(Q\d+)\.json/)[1];
    return { entities: { [id]: { claims: id === "Q999001" ? { P106: [{ mainsnak: { datavalue: { value: { id: "Q82955" } } } }] } : {} } } };
  },
});

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
  const pushes = [];
  const deadEndpoints = new Set();
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
    screener: testScreener,
    fetch: testFetch,
    // Phone notifications: kept here for tests to look at. Endpoints in deadEndpoints act like a phone that uninstalled the app.
    pushSender: async (sub, payload) => {
      if (deadEndpoints.has(sub.endpoint)) throw Object.assign(new Error("gone"), { statusCode: 410 });
      pushes.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
    },
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
    runNudges: () => handler.runNudges(),
    runPush: () => handler.runPush(),
    runReels: () => handler.runReels(),
    pushes,
    deadEndpoints,
    overpassCalls,
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
      const m = b.last.body.match(/name="_token" value="([^"]+)"/) || b.last.body.match(/_token=([^"&]+)/);
      return m[1];
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
function phonePhoto({ width = 2000, height = 1500, color = "#4a7" } = {}) {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg()
    .withMetadata({ exif: { IFD3: { GPSLatitudeRef: "N", GPSLatitude: "37/1 12/1 55/1" } } })
    .toBuffer();
}

/** A multipart/form-data body with fields and several files (all in field `field`). */
function multipartMany(fields, field, buffers) {
  const boundary = "----test" + Date.now() + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  buffers.forEach((buffer, i) => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="p${i}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), buffer, Buffer.from("\r\n"));
  });
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

/** A multipart/form-data body with one file. */
function multipart(field, filename, buffer, type = "image/jpeg") {
  const boundary = "----test" + Date.now();
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, buffer, tail]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

module.exports = { startApp, signIn, join, phonePhoto, multipart, multipartMany, OWNER, SITE_URL };
