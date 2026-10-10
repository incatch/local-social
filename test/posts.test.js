const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { startApp, join, phonePhoto, multipartMany } = require("./helpers");

let app;
let sam;
let alex;
test.before(async () => {
  app = await startApp();
  sam = await join(app, "sam@example.com", "sam");
  alex = await join(app, "alex@example.com", "alex");
});
test.after(() => app.stop());

// A spot in Springfield, and one in Nixa (about 12 miles south).
const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
const NIXA = { lat: "37.0434", lon: "-93.2944" };

async function share(b, { caption = "", photos = 1, where = SPRINGFIELD, json = false } = {}) {
  await b.get("/new");
  const token = b.token();
  const fields = { caption, ...(where ? { with_location: "on", ...where } : {}) };
  const files = [];
  for (let i = 0; i < photos; i++) files.push(await phonePhoto({ width: 2400 - i * 100, height: 1800 }));
  const upload = multipartMany(fields, "photos", files);
  return b.request(`/new?_token=${token}`, { body: upload.body, headers: { ...upload.headers, ...(json ? { accept: "application/json" } : {}) } });
}
const postIdFrom = (res) => Number((res.location || JSON.parse(res.body).location).match(/\/p\/(\d+)/)[1]);

test("sharing a post: photos cleaned and resized, town added, @mentions linked", async () => {
  const res = await share(sam, { caption: "Sunset with @alex and @nobody_here", photos: 2 });
  assert.match(res.location, /^\/p\/\d+$/);
  const id = postIdFrom(res);
  const post = await app.store.post(id, 0);
  assert.equal(post.area_name, "Springfield, MO");
  assert.notEqual(post.lat, 37.2087, "the exact spot isn't kept");
  assert.equal(post.photos.length, 2);
  for (const ph of post.photos) {
    const full = await sharp(fs.readFileSync(path.join(app.mediaDir, ph.photo_key))).metadata();
    const thumb = await sharp(fs.readFileSync(path.join(app.mediaDir, ph.thumb_key))).metadata();
    assert.equal(full.format, "webp");
    assert.equal(Math.max(full.width, full.height), 1600);
    assert.equal(full.exif, undefined);
    assert.equal(thumb.width, 480);
    assert.equal(thumb.height, 480);
  }
  const { rows } = await app.pool.query("select u.username from mentions m join users u on u.id = m.user_id where m.post_id = $1", [id]);
  assert.deepEqual(rows.map((r) => r.username), ["alex"]);

  await alex.get(`/p/${id}`);
  assert.match(alex.last.body, /<a href="\/@alex">@alex<\/a>/);
  assert.match(alex.last.body, /Springfield, MO/);
  assert.match(alex.last.body, /2 of 2/);
});

test("sharing without a location; and the JSON answer the page's script uses", async () => {
  const res = await share(sam, { caption: "home", where: null, json: true });
  assert.equal(res.status, 200);
  const post = await app.store.post(postIdFrom(res), 0);
  assert.equal(post.lat, null);
  assert.equal(post.area_name, null);
});

test("sharing needs a photo, a short enough caption, and the form token", async () => {
  await sam.get("/new");
  const empty = multipartMany({ caption: "no photos" }, "photos", []);
  await sam.request(`/new?_token=${sam.token()}`, { body: empty.body, headers: empty.headers });
  assert.match(sam.last.body, /at least one photo/);
  const long = await share(sam, { caption: "x".repeat(2201) });
  assert.equal(long.status, 400);
  assert.match(long.body, /up to 2200 characters/);
  const files = fs.readdirSync(path.join(app.mediaDir, "media")).length;
  const bad = multipartMany({}, "photos", [Buffer.from("not a photo")]);
  await sam.request(`/new?_token=${sam.token()}`, { body: bad.body, headers: bad.headers });
  assert.match(sam.last.body, /doesn&#39;t look like a photo/);
  assert.equal(fs.readdirSync(path.join(app.mediaDir, "media")).length, files, "nothing left behind");
  const forged = multipartMany({}, "photos", [await phonePhoto()]);
  assert.equal((await sam.request("/new?_token=forged", { body: forged.body, headers: forged.headers })).status, 400);
});

test("likes, comments, and who may delete what", async () => {
  const id = postIdFrom(await share(sam, { caption: "likes" }));
  await alex.get(`/p/${id}`);
  const token = alex.token();
  const likeJson = () => alex.request(`/p/${id}/like`, { form: { _token: token }, headers: { accept: "application/json" } });
  assert.deepEqual(JSON.parse((await likeJson()).body), { liked: true, count: 1 });
  assert.deepEqual(JSON.parse((await likeJson()).body), { liked: false, count: 0 });
  await alex.get(`/p/${id}`);
  await alex.post(`/p/${id}/like`);
  assert.equal((await app.store.post(id, 0)).like_count, 1);

  await alex.get(`/p/${id}`);
  await alex.post(`/p/${id}/comments`, { body: "Nice one @sam" });
  assert.match(alex.last.location, new RegExp(`/p/${id}#c\\d+`));
  await alex.get(`/p/${id}`);
  await alex.post(`/p/${id}/comments`, { body: "   " });
  assert.match(alex.last.body, /write a comment/);
  await sam.get(`/p/${id}`);
  assert.match(sam.last.body, /Nice one <a href="\/@sam">@sam<\/a>/);
  assert.equal((await app.store.post(id, 0)).comment_count, 1);

  // Alex can't edit or delete Sam's post; Sam can delete Alex's comment on it.
  await alex.get(`/p/${id}`);
  await alex.post(`/p/${id}/caption`, { caption: "hacked" });
  assert.equal(alex.last.status, 400);
  await alex.get(`/p/${id}`);
  await alex.post(`/p/${id}/delete`);
  assert.equal(alex.last.status, 400);
  const [comment] = await app.store.comments(id);
  await sam.get(`/p/${id}`);
  await sam.post(`/p/${id}/comments/${comment.id}/delete`);
  assert.equal((await app.store.comments(id)).length, 0);
  assert.equal((await app.store.post(id, 0)).comment_count, 0);
});

test("editing and deleting your own post (its photos go too)", async () => {
  const id = postIdFrom(await share(sam, { caption: "before" }));
  const post = await app.store.post(id, 0);
  await sam.get(`/p/${id}`);
  await sam.post(`/p/${id}/caption`, { caption: "after" });
  assert.equal((await app.store.post(id, 0)).caption, "after");
  await sam.get(`/p/${id}`);
  await sam.post(`/p/${id}/delete`);
  assert.equal(sam.last.location, "/@sam");
  assert.equal(await app.store.post(id, 0), null);
  assert.ok(!fs.existsSync(path.join(app.mediaDir, post.photos[0].photo_key)));
  assert.equal((await sam.get(`/p/${id}`)).status, 404);
});

test("following, profile counts and grid, and the Following feed", async () => {
  const pat = await join(app, "pat@example.com", "pat");
  const patPost = postIdFrom(await share(pat, { caption: "pat's post" }));
  await alex.get("/?tab=following");
  assert.doesNotMatch(alex.last.body, /pat&#39;s post/);

  await alex.get("/@pat");
  assert.match(alex.last.body, /<strong>0<\/strong> followers/);
  await alex.post("/@pat/follow");
  await alex.get("/@pat");
  assert.match(alex.last.body, /<strong>1<\/strong> follower</);
  assert.match(alex.last.body, />Following</);
  assert.match(alex.last.body, new RegExp(`href="/p/${patPost}"`));
  await alex.get("/?tab=following");
  assert.match(alex.last.body, /pat&#39;s post/);

  await alex.get("/@pat");
  await alex.post("/@pat/follow");
  assert.equal((await app.store.followStats((await app.store.userByUsername("pat")).id, 0)).followers, 0);
  await pat.get("/@pat");
  assert.doesNotMatch(pat.last.body, /\/@pat\/follow/, "no follow button on your own profile");
});

test("the Nearby feed: needs your location, respects the distance, skips posts without a place", async () => {
  const lee = await join(app, "lee@example.com", "lee");
  await share(lee, { caption: "in nixa", where: NIXA });
  await share(lee, { caption: "nowhere", where: null });
  const viewer = await join(app, "viewer@example.com", "viewer");
  await viewer.get("/");
  assert.match(viewer.last.body, /Use my location/);
  assert.doesNotMatch(viewer.last.body, /in nixa/);

  await viewer.post("/feed/location", SPRINGFIELD);
  assert.equal(viewer.last.location, "/?tab=nearby");
  await viewer.get("/");
  assert.match(viewer.last.body, /Sunset with/, "Springfield posts within 10 miles");
  assert.doesNotMatch(viewer.last.body, /in nixa/, "Nixa is ~12 miles away");
  assert.doesNotMatch(viewer.last.body, /nowhere/);

  await viewer.post("/feed/radius", { miles: "25" });
  await viewer.get("/");
  assert.doesNotMatch(viewer.last.body, /in nixa/, "a new post ripples out to 10 miles at first");
  await app.pool.query("update posts set like_count = 3 where caption = 'in nixa'");
  await viewer.get("/");
  assert.match(viewer.last.body, /in nixa/, "with 3 likes it reaches 25 miles");
  await viewer.post("/feed/radius", { miles: "7" });
  assert.equal(viewer.last.status, 400);

  // Banned people's posts disappear.
  await app.store.ban((await app.store.userByUsername("lee")).id, "test");
  await viewer.get("/");
  assert.doesNotMatch(viewer.last.body, /in nixa/);
});

test("feeds page through 20 at a time", async () => {
  const busy = await join(app, "busy@example.com", "busy");
  const me = await app.store.userByUsername("busy");
  for (let i = 0; i < 21; i++) {
    await app.store.createPost(me.id, { caption: `busy post ${i}`, photos: [{ photoKey: "media/" + "a".repeat(32) + ".webp", thumbKey: "media/" + "b".repeat(32) + ".webp", width: 10, height: 10 }], place: null, areaName: null });
  }
  await busy.get("/?tab=following");
  assert.match(busy.last.body, /busy post 20/);
  assert.doesNotMatch(busy.last.body, /busy post 0</);
  assert.match(busy.last.body, /page=1/);
  await busy.get("/?tab=following&page=1");
  assert.match(busy.last.body, /busy post 0</);
});

test("deleting your account deletes your posts' photos", async () => {
  const gone = await join(app, "gone2@example.com", "gone2");
  const id = postIdFrom(await share(gone, { caption: "bye" }));
  const key = (await app.store.post(id, 0)).photos[0].photo_key;
  await gone.get("/settings");
  await gone.post("/settings/delete", { confirm: "gone2" });
  assert.ok(!fs.existsSync(path.join(app.mediaDir, key)));
  assert.equal(await app.store.post(id, 0), null);
});
