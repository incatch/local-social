const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, join, phonePhoto, multipartMany, OWNER } = require("./helpers");
const { politicalWord, DEFAULT_WORDS } = require("../lib/politics");

let app;
let poster;
let neighbor;
let admin;
test.before(async () => {
  app = await startApp();
  poster = await join(app, "poster@example.com", "poster");
  neighbor = await join(app, "neighbor@example.com", "neighbor");
  admin = app.browser();
  await neighbor.get("/");
  await neighbor.post("/feed/location", SPRINGFIELD);
});
test.after(() => app.stop());

const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
const as = { headers: { "x-test-admin": OWNER } };

async function share(caption, color = "#4a7") {
  await poster.get("/new");
  const up = multipartMany({ caption, with_location: "on", ...SPRINGFIELD }, "photos", [await phonePhoto({ color })]);
  const res = await poster.request(`/new?_token=${poster.token()}`, { body: up.body, headers: up.headers });
  return res.location.split("/").pop();
}
async function nearby() {
  return (await neighbor.get("/?tab=nearby")).body;
}

test("matching political words: whole words, any capitalisation", () => {
  assert.equal(politicalWord("Go #MAGA!", DEFAULT_WORDS), "maga");
  assert.equal(politicalWord("vote for my band", DEFAULT_WORDS), "vote for");
  assert.equal(politicalWord("Election day pancakes", DEFAULT_WORDS), "election");
  assert.equal(politicalWord("I woke up and had a trumpet lesson", DEFAULT_WORDS), null, "no partial words");
  assert.equal(politicalWord("Sunset at the lake", DEFAULT_WORDS), null);
});

test("political captions, photo text and political figures stay off Nearby, but followers see them", async () => {
  const plain = await share("Sunset at the lake");
  const caption = await share("Everyone vote for Smith on Tuesday");
  const sign = await share("look what I saw downtown", "#ffff00");
  const figure = await share("met someone today", "#ff00ff");

  const feed = await nearby();
  assert.match(feed, /Sunset at the lake/);
  assert.doesNotMatch(feed, /vote for Smith/);
  assert.doesNotMatch(feed, /look what I saw downtown/);
  assert.doesNotMatch(feed, /met someone today/);

  // The poster is told why; the posts still exist.
  await poster.get(`/p/${caption}`);
  assert.match(poster.last.body, /Not shown on Nearby: it looks political/);
  await poster.get(`/p/${plain}`);
  assert.doesNotMatch(poster.last.body, /Not shown on Nearby/);
  assert.equal((await app.store.postForModeration(sign)).nearby_reason, 'Photo text mentions "biden"');
  assert.equal((await app.store.postForModeration(figure)).nearby_reason, "Photo shows Jane Senator");
  assert.equal((await app.store.politicalPerson("Q999001")).political, true, "looked up once, then remembered");

  // Followers see them in Following.
  await neighbor.get("/@poster");
  await neighbor.post("/@poster/follow");
  const following = (await neighbor.get("/?tab=following")).body;
  assert.match(following, /vote for Smith/);
  assert.match(following, /met someone today/);
});

test("editing the caption re-checks it", async () => {
  const id = await share("Pancakes!");
  await poster.get(`/p/${id}`);
  await poster.post(`/p/${id}/caption`, { caption: "Pancakes! Also: impeach everyone" });
  assert.match((await nearby()), /Sunset at the lake/);
  assert.doesNotMatch(await nearby(), /impeach everyone/);
  await poster.get(`/p/${id}`);
  await poster.post(`/p/${id}/caption`, { caption: "Just pancakes" });
  assert.match(await nearby(), /Just pancakes/);
});

test("the owner can show a post on Nearby anyway, change the words, or turn it off", async () => {
  await admin.request("/admin/nearby", as);
  assert.match(admin.last.body, /Kept off Nearby/);
  assert.match(admin.last.body, /Caption mentions &quot;vote for&quot;/);
  const id = (await app.pool.query("select id from posts where caption like 'Everyone vote for%'")).rows[0].id;
  await admin.request(`/admin/nearby/${id}/show`, { ...as, form: { _token: admin.token() } });
  assert.match(await nearby(), /vote for Smith/);

  // A new word list (and the last 30 days are re-checked).
  await admin.request("/admin/nearby", as);
  await admin.request("/admin/nearby", { ...as, form: { _token: admin.token(), nearby_politics_filter: "on", political_words: "pancakes", political_names: "" } });
  assert.doesNotMatch(await nearby(), /Just pancakes/);
  assert.doesNotMatch(await nearby(), /met someone today/, "political figures still count");
  assert.match(await nearby(), /look what I saw downtown/, "'biden' isn't on the new list");

  // Off: everything with a place is on Nearby again.
  await admin.request("/admin/nearby", as);
  await admin.request("/admin/nearby", { ...as, form: { _token: admin.token(), political_words: "pancakes" } });
  const feed = await nearby();
  assert.match(feed, /Just pancakes/);
  assert.match(feed, /met someone today/);
});
