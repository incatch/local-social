const test = require("node:test");
const assert = require("node:assert/strict");
const webpush = require("web-push");
const { startApp, join, phonePhoto, multipartMany, OWNER } = require("./helpers");
const { vapidKeys } = require("../lib/push");
const { featureOn } = require("../lib/features");

let app;
let sam;
let alex;
const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
const as = { headers: { "x-test-admin": OWNER } };
const PHONE = { endpoint: "https://push.example.com/send/alex-phone-123", p256dh: "B".repeat(87), auth: "a".repeat(22) };

test.before(async () => {
  app = await startApp();
  sam = await join(app, "sam@example.com", "sam", { display_name: "Sam Rivers" });
  await sam.get("/");
  await sam.post("/feed/location", SPRINGFIELD);
});
test.after(() => app.stop());

async function share(b, caption) {
  await b.get("/new");
  const up = multipartMany({ caption, with_location: "on", ...SPRINGFIELD }, "photos", [await phonePhoto()]);
  const res = await b.request(`/new?_token=${b.token()}`, { body: up.body, headers: up.headers });
  return res.location.split("/").pop();
}

test("the first look: right after joining, see that it's alive around you", async () => {
  const postId = await share(sam, "Sunset over the square");
  alex = await join(app, "alex@example.com", "alex", { display_name: "Alex Stone" });
  assert.equal(alex.last.location, "/hello");
  await alex.get("/hello");
  assert.match(alex.last.body, /Show me what's around me/);

  await alex.post("/feed/location", { ...SPRINGFIELD, back: "/hello" });
  assert.equal(alex.last.location, "/hello");
  await alex.get("/hello");
  assert.match(alex.last.body, /<strong>1<\/strong> person/);
  assert.match(alex.last.body, /within 10 miles of Springfield/);
  assert.match(alex.last.body, /best of this week around Springfield/);
  assert.match(alex.last.body, new RegExp(`href="/p/${postId}"`));
  assert.match(alex.last.body, /Sam Rivers/, "people to follow");
  assert.match(alex.last.body, /Turn on notifications/);
  assert.match(alex.last.body, /Start exploring/);

  // Following from the first look comes back to it.
  await alex.post("/@sam/follow", { back: "/hello" });
  assert.equal(alex.last.location, "/@sam", "only /search and /activity are allowed back-links for follows");
});

test("push keys are valid and the same on every container", () => {
  const a = vapidKeys("one secret");
  assert.deepEqual(a, vapidKeys("one secret"));
  assert.notDeepEqual(a, vapidKeys("another secret"));
  assert.equal(Buffer.from(a.publicKey, "base64url").length, 65);
  webpush.setVapidDetails("mailto:test@example.com", a.publicKey, a.privateKey);
});

test("phone notifications: likes, comments, follows and messages (never what a message says)", async () => {
  await alex.get("/activity");
  assert.match(alex.last.body, /data-push=/, "Activity offers notifications until a device is on");
  await alex.get("/settings");
  const bad = await alex.request("/push/subscribe", { form: { _token: alex.token(), endpoint: "http://not-secure", p256dh: "x", auth: "y" } });
  assert.equal(bad.status, 400);
  await alex.get("/settings");
  assert.match(alex.last.body, /Phone notifications/);
  const ok = await alex.post("/push/subscribe", PHONE);
  assert.equal(ok.status, 200);
  await alex.get("/activity");
  assert.doesNotMatch(alex.last.body, /data-push=/);

  // Something old doesn't suddenly buzz.
  await app.pool.query("update notifications set created_at = now() - interval '1 hour', pushed_at = null");
  await app.runPush();
  assert.equal(app.pushes.length, 0);

  const alexPost = await share(alex, "Coffee at the corner");
  await sam.get(`/p/${alexPost}`);
  await sam.post(`/p/${alexPost}/like`);
  await sam.get(`/p/${alexPost}`);
  await sam.post(`/p/${alexPost}/comments`, { body: "Best latte in town" });
  await sam.get("/@alex");
  await sam.post("/@alex/follow");
  await sam.get("/@alex");
  await sam.post("/@alex/message");
  const chat = sam.last.location;
  await sam.get(chat);
  await sam.post(chat, { body: "my secret surprise party plan" });
  await app.runPush();
  const bodies = app.pushes.map((p) => p.body);
  assert.ok(bodies.includes("Sam Rivers liked your post"), bodies.join(" | "));
  assert.ok(bodies.includes("Sam Rivers commented: “Best latte in town”"));
  assert.ok(bodies.includes("Sam Rivers started following you"));
  assert.ok(bodies.some((b) => /Sam Rivers (sent you a message|wants to message you)/.test(b)));
  assert.ok(!JSON.stringify(app.pushes).includes("secret surprise"));
  assert.ok(app.pushes.every((p) => p.endpoint === PHONE.endpoint));
  assert.equal(app.pushes.find((p) => /liked/.test(p.body)).url, `/p/${alexPost}`);
  assert.equal(app.pushes.find((p) => /message/.test(p.body)).tag, `c${chat.split("/").pop()}`);

  // Each is sent once.
  const sent = app.pushes.length;
  await app.runPush();
  assert.equal(app.pushes.length, sent);

  // "Send me a test".
  await alex.get("/settings");
  const t = await alex.post("/push/test");
  assert.equal(JSON.parse(t.body).sent, 1);
  assert.match(app.pushes.at(-1).body, /Notifications are on/);
});

test("phones that turned notifications off are forgotten; turning off on a device", async () => {
  const alexId = (await app.store.userByUsername("alex")).id;
  app.deadEndpoints.add(PHONE.endpoint);
  await alex.get("/settings");
  await alex.post("/push/test");
  assert.equal(await app.store.pushDeviceCount(alexId), 0);
  app.deadEndpoints.clear();

  await alex.get("/settings");
  await alex.post("/push/subscribe", PHONE);
  assert.equal(await app.store.pushDeviceCount(alexId), 1);
  await alex.get("/settings");
  await alex.post("/push/unsubscribe", { endpoint: PHONE.endpoint });
  assert.equal(await app.store.pushDeviceCount(alexId), 0);
});

test("Admin → New features: Off, 18+ only or Everyone for each", async () => {
  const s = await app.store.settings();
  assert.deepEqual(s.features, { pullup: "adults", squads: "adults", drops: "adults", heatmap: "adults", reels: "adults" });
  const admin = app.browser();
  await admin.request("/admin/features", as);
  assert.match(admin.last.body, /Drops/);
  assert.match(admin.last.body, /name="feature_drops" value="adults" checked/);
  await admin.request("/admin/features", { ...as, form: { _token: admin.token(), feature_drops: "everyone", feature_reels: "off", feature_pullup: "nonsense" } });
  const after = (await app.store.settings()).features;
  assert.equal(after.drops, "everyone");
  assert.equal(after.reels, "off");
  assert.equal(after.pullup, "adults");
  const adult = { is_teen: false };
  const teen = { is_teen: true };
  assert.equal(featureOn({ features: after }, "drops", teen), true);
  assert.equal(featureOn({ features: after }, "squads", teen), false);
  assert.equal(featureOn({ features: after }, "squads", adult), true);
  assert.equal(featureOn({ features: after }, "reels", adult), false);
});
