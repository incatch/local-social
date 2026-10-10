const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { startApp, join, phonePhoto, multipart, SITE_URL } = require("./helpers");

let app;
let sam;
test.before(async () => {
  app = await startApp();
  sam = await join(app, "sam@example.com", "sam");
});
test.after(() => app.stop());

test("home and profile pages", async () => {
  await sam.get("/");
  assert.match(sam.last.body, /Nearby/);
  await sam.get("/@sam");
  assert.equal(sam.last.status, 200);
  assert.match(sam.last.body, /Edit profile/);
  const alex = await join(app, "alex@example.com", "alex");
  await alex.get("/@SAM");
  assert.equal(alex.last.status, 200);
  assert.doesNotMatch(alex.last.body, /Edit profile/);
  assert.equal((await alex.get("/@nobody")).status, 404);
});

test("editing the profile", async () => {
  await sam.get("/settings");
  await sam.post("/settings/profile", { display_name: "Sam Smith", username: "sam.smith", bio: "Coffee & <hiking>" });
  assert.equal(sam.last.location, "/settings?done=saved");
  await sam.get("/@sam.smith");
  assert.match(sam.last.body, /Sam Smith/);
  assert.match(sam.last.body, /Coffee &amp; &lt;hiking&gt;/);
  await sam.get("/settings");
  await sam.post("/settings/profile", { display_name: "Sam", username: "alex", bio: "" });
  assert.match(sam.last.body, /username is taken/);
  await sam.post("/settings/profile", { display_name: "Sam", username: "sam", bio: "" });
});

test("profile photos lose their hidden location data and are resized", async () => {
  await sam.get("/settings");
  const upload = multipart("photo", "IMG_0001.jpg", await phonePhoto());
  await sam.request(`/settings/photo?_token=${sam.token()}`, { body: upload.body, headers: upload.headers });
  assert.equal(sam.last.location, "/settings?done=photo");
  const user = await app.store.userByUsername("sam");
  assert.match(user.photo_key, /^media\/[0-9a-f]{32}\.webp$/);
  const stored = fs.readFileSync(path.join(app.mediaDir, user.photo_key));
  const meta = await sharp(stored).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 512);
  assert.equal(meta.exif, undefined, "no EXIF (and so no GPS) in the stored photo");

  // Served to signed-in people only.
  const res = await sam.get(`/${user.photo_key}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/webp");
  assert.equal((await app.browser().get(`/${user.photo_key}`)).location, "/sign-in");

  // A new photo replaces (and deletes) the old one.
  await sam.get("/settings");
  const again = multipart("photo", "IMG_0002.jpg", await phonePhoto({ width: 800, height: 800 }));
  await sam.request(`/settings/photo?_token=${sam.token()}`, { body: again.body, headers: again.headers });
  assert.ok(!fs.existsSync(path.join(app.mediaDir, user.photo_key)));

  // Not a photo.
  await sam.get("/settings");
  const bad = multipart("photo", "notes.jpg", Buffer.from("hello"), "image/jpeg");
  await sam.request(`/settings/photo?_token=${sam.token()}`, { body: bad.body, headers: bad.headers });
  assert.equal(sam.last.status, 400);
  assert.match(sam.last.body, /doesn&#39;t look like a photo/);

  // Uploads need the form token too.
  const forged = multipart("photo", "x.jpg", await phonePhoto());
  await sam.request(`/settings/photo?_token=forged`, { body: forged.body, headers: forged.headers });
  assert.equal(sam.last.status, 400);
});

test("your area: rounded to about a mile, shown as a town", async () => {
  await sam.get("/settings");
  // An exact spot in Springfield.
  await sam.post("/settings/area", { lat: "37.208713", lon: "-93.292353" });
  assert.equal(sam.last.location, "/settings?done=area");
  const user = await app.store.userByUsername("sam");
  assert.equal(user.area_name, "Springfield, MO");
  assert.notEqual(user.area_lat, 37.208713, "the exact spot isn't kept");
  assert.ok(Math.abs(user.area_lat - 37.208713) < 0.01 && Math.abs(user.area_lon + 93.292353) < 0.02);
  await sam.get("/@sam");
  assert.match(sam.last.body, /@sam · Springfield, MO/);

  await sam.get("/settings");
  await sam.post("/settings/area", { lat: "", lon: "" });
  assert.match(sam.last.body, /couldn&#39;t get your location/);
  await sam.post("/settings/area", { lat: "10", lon: "10" });
  assert.match(sam.last.body, /couldn&#39;t find a town/);
  await sam.post("/settings/area/clear", {});
  assert.equal((await app.store.userByUsername("sam")).area_name, null);
});

test("forms need the page's token, and must come from the site", async () => {
  await sam.get("/settings");
  let res = await sam.request("/settings/profile", { form: { _token: "nope", display_name: "Hacked", username: "sam" } });
  assert.equal(res.status, 400);
  res = await sam.request("/settings/profile", { form: { _token: sam.token(), display_name: "Hacked", username: "sam" }, headers: { origin: "https://evil.example" } });
  assert.equal(res.status, 403);
  assert.notEqual((await app.store.userByUsername("sam")).display_name, "Hacked");
});

test("signing out on every device", async () => {
  const other = await join(app, "multi@example.com", "multi");
  // The same person on a second device.
  const second = app.browser();
  for (const [k, v] of other.cookies) second.cookies.set(k, v);
  assert.equal((await second.get("/")).status, 200);
  await other.get("/settings");
  await other.post("/sign-out/everywhere", {});
  assert.equal(other.last.location, "/settings?done=everywhere");
  assert.equal((await other.get("/")).status, 200, "this device stays signed in");
  assert.match((await second.get("/")).body, /Sign in or join/, "the other device is signed out");
});

test("deleting your account", async () => {
  const gone = await join(app, "gone@example.com", "gone");
  await gone.get("/settings");
  const upload = multipart("photo", "a.jpg", await phonePhoto());
  await gone.request(`/settings/photo?_token=${gone.token()}`, { body: upload.body, headers: upload.headers });
  const key = (await app.store.userByUsername("gone")).photo_key;
  await gone.get("/settings");
  await gone.post("/settings/delete", { confirm: "wrong" });
  assert.match(gone.last.body, /type your username exactly/);
  await gone.post("/settings/delete", { confirm: "@gone" });
  assert.match(gone.last.body, /Account deleted/);
  assert.equal(await app.store.userByUsername("gone"), null);
  assert.ok(!fs.existsSync(path.join(app.mediaDir, key)));
  assert.match((await gone.get("/")).body, /Sign in or join/);
});
