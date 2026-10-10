const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, join, signIn, phonePhoto, multipartMany, OWNER } = require("./helpers");

let app;
let sam;
let nixa;
const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
const NIXA = { lat: "37.0434", lon: "-93.2944" };

test.before(async () => {
  app = await startApp();
  sam = await join(app, "sam@example.com", "sam");
  nixa = await join(app, "nixa@example.com", "nixaperson");
  await sam.get("/");
  await sam.post("/feed/location", SPRINGFIELD);
});
test.after(() => app.stop());

async function share(b, caption, where) {
  await b.get("/new");
  const up = multipartMany({ caption, with_location: "on", ...where }, "photos", [await phonePhoto()]);
  await b.request(`/new?_token=${b.token()}`, { body: up.body, headers: up.headers });
}

test("visiting another town: one tap from the town chip, read-only, easy way back", async () => {
  await share(nixa, "Nixa sweet corn festival", NIXA);
  await sam.get("/?tab=nearby&page=0");
  assert.match(sam.last.body, /class="town-picker"/);
  assert.match(sam.last.body, /Springfield<\/span><\/summary>/);
  assert.match(sam.last.body, /visit=Nixa%2C%20MO/, "nearby towns to peek at, one tap each");
  await sam.get("/?tab=nearby&visit=Nixa%2C%20MO");
  assert.match(sam.last.body, /Visiting <strong>Nixa, MO<\/strong>/);
  assert.match(sam.last.body, /Nixa sweet corn festival/);
  assert.match(sam.last.body, /Back home/);
  // Typing part of a name works too, and nothing about your own spot changed.
  await sam.get("/?tab=nearby&visit=nix");
  assert.match(sam.last.body, /Visiting <strong>Nixa, MO<\/strong>/);
  const me = await app.store.userByUsername("sam");
  assert.ok(Math.abs(me.feed_lat - 37.2087) < 0.02);
  await sam.get("/?tab=nearby&visit=Atlantis");
  assert.match(sam.last.body, /couldn&#39;t find a town|couldn't find a town/);
  // Suggestions as you type.
  const res = await sam.get("/places/search?q=spring", { headers: { accept: "application/json" } });
  assert.equal(JSON.parse(res.body)[0], "Springfield, MO");
});

test("today's recap: a collage of the day's local photos, ready to share", async () => {
  for (const c of ["Morning coffee", "Lunch at the square", "Sunset walk"]) await share(sam, c, SPRINGFIELD);
  await sam.get("/today");
  assert.match(sam.last.body, /Today in Springfield/);
  assert.equal((sam.last.body.match(/<div class="recap-preview">[\s\S]*?<\/div>/)[0].match(/<img/g) || []).length, 3);
  assert.match(sam.last.body, /data-share-card='[^']*&quot;kind&quot;:&quot;recap&quot;/);
});

test("invite cards: every member has one, with a QR code; it brings people in", async () => {
  await sam.get("/invite");
  assert.match(sam.last.body, /invited you to/);
  assert.match(sam.last.body, /<svg[^>]*viewBox/);
  const link = sam.last.body.match(/data-share-link="([^"]+)"/)[1];
  assert.match(link, /\/join\/[A-Z0-9]{8}$/);
  assert.match(sam.last.body, /5 of 5 invites left/);
  await sam.get("/invite");
  assert.equal(sam.last.body.match(/data-share-link="([^"]+)"/)[1], link, "the same card each time");

  // A friend uses it.
  const friend = app.browser();
  await friend.get(new URL(link).pathname);
  await signIn(app, friend, "friend@example.com");
  await friend.get("/welcome");
  assert.match(friend.last.body, new RegExp(`value="${link.split("/").pop()}"`), "the code is filled in");
  await friend.post("/welcome", { invite: link.split("/").pop(), birth_date: "1990-01-01", username: "friend", display_name: "Friend", terms: "on" });
  assert.equal(friend.last.location, "/");
  await sam.get("/invite");
  assert.match(sam.last.body, /4 of 5 invites left/);

  // The owner can turn member invites off.
  const admin = app.browser();
  const as = { headers: { "x-test-admin": OWNER } };
  await admin.request("/admin/nearby", as);
  await admin.request("/admin/nearby", { ...as, form: { _token: admin.token(), invites_per_member: "0", today_recap_enabled: "on", nearby_politics_filter: "on" } });
  await sam.get("/invite");
  assert.match(sam.last.body, /Invites are closed/);
});

test("the recap page never names other apps", async () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "../lib/growth-views.js"), "utf8");
  assert.doesNotMatch(src, /Instagram|Snapchat|TikTok/);
});
