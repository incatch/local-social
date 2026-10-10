const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, join, phonePhoto, multipart, multipartMany } = require("./helpers");
const { streakFrom } = require("../lib/irl-store");

let app;
let sam;
let alex;
let jo;
const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
const KANSAS_CITY = { lat: "39.0997", lon: "-94.5786" };

test.before(async () => {
  app = await startApp();
  sam = await join(app, "sam@example.com", "sam", { display_name: "Sam Rivers" });
  alex = await join(app, "alex@example.com", "alex", { display_name: "Alex Stone" });
  jo = await join(app, "jo@example.com", "jojo", { display_name: "Jo March" });
  for (const b of [sam, alex, jo]) {
    await b.get("/");
    await b.post("/feed/location", SPRINGFIELD);
  }
  // Sam and Alex follow each other; Jo only follows Sam.
  for (const [b, who] of [[sam, "alex"], [alex, "sam"], [jo, "sam"]]) {
    await b.get(`/@${who}`);
    await b.post(`/@${who}/follow`);
  }
});
test.after(() => app.stop());

async function share(b, caption, { color } = {}) {
  await b.get("/new");
  const up = multipartMany({ caption, with_location: "on", ...SPRINGFIELD }, "photos", [await phonePhoto(color ? { color } : {})]);
  const res = await b.request(`/new?_token=${b.token()}`, { body: up.body, headers: up.headers });
  return res.location.split("/").pop();
}
const activity = async (b) => (await b.get("/activity")).body;

test("Pull Up: on my way, then pulled up once you're there, with a selfie", async () => {
  const id = await share(sam, "Pickup game at the park, come through");
  await sam.get(`/p/${id}`);
  assert.doesNotMatch(sam.last.body, /🙋 Pull up<\/button>/, "not on your own post");
  await alex.get(`/p/${id}`);
  assert.match(alex.last.body, /🙋 Pull up<\/button>/);

  await alex.post(`/p/${id}/pullup`);
  assert.equal(alex.last.location, `/p/${id}#pullup`);
  assert.match(await activity(sam), /is on the way to your/);
  await alex.get(`/p/${id}`);
  assert.match(alex.last.body, /You're on your way/);
  assert.match(alex.last.body, /1 on the way/);

  // From Kansas City: not there yet.
  const far = await alex.post(`/p/${id}/pullup/here`, KANSAS_CITY);
  assert.equal(far.status, 400);
  assert.match(far.body, /not there yet/);
  await alex.get(`/p/${id}`);
  await alex.post(`/p/${id}/pullup/here`, { lat: "37.2101", lon: "-93.2899" });
  assert.equal(alex.last.location, `/p/${id}#pullup`);
  assert.match(await activity(sam), /<strong>pulled up<\/strong> to your/);
  await alex.get(`/p/${id}`);
  assert.match(alex.last.body, /You pulled up 👋/);
  assert.match(alex.last.body, /Add a selfie/);

  // The selfie is screened like any photo.
  const bad = multipart("photo", "me.jpg", await phonePhoto({ color: "#ff0000" }));
  assert.equal((await alex.request(`/p/${id}/pullup/selfie?_token=${alex.token()}`, { body: bad.body, headers: bad.headers })).status, 400);
  await alex.get(`/p/${id}`);
  const up = multipart("photo", "me.jpg", await phonePhoto());
  await alex.request(`/p/${id}/pullup/selfie?_token=${alex.token()}`, { body: up.body, headers: up.headers });
  await sam.get(`/p/${id}`);
  assert.match(sam.last.body, /class="pullup-face"[^>]*><img src="\/media\//);
  assert.match(sam.last.body, /1 pulled up/);

  // A day later it's closed.
  const old = await share(sam, "Yesterday's thing");
  await app.pool.query("update posts set created_at = now() - interval '2 days' where id = $1", [old]);
  await alex.get(`/p/${old}`);
  assert.doesNotMatch(alex.last.body, /🙋 Pull up<\/button>/);
  await alex.get(`/p/${id}`);
  assert.equal((await alex.post(`/p/${old}/pullup`)).status, 400);
});

test("Pull Up on plans, and the owner can switch it off", async () => {
  await sam.get("/around/new?kind=plan");
  await sam.post("/around/new", { kind: "plan", body: "Tacos at the square, who's in", plan_at_iso: new Date(Date.now() + 3600000).toISOString() });
  const plan = sam.last.location.split("/").pop();
  await jo.get(`/s/${plan}`);
  assert.match(jo.last.body, /🙋 Pull up<\/button>/);
  await jo.post(`/s/${plan}/pullup`);
  assert.equal(jo.last.location, `/s/${plan}#pullup`);
  assert.match(await activity(sam), /is on the way to your <a href="\/s\/\d+#pullup">plan/);

  await app.store.setFeatures({ feature_pullup: "off" });
  await jo.get(`/s/${plan}`);
  assert.doesNotMatch(jo.last.body, /Pull Up/);
  await app.store.setFeatures({ feature_pullup: "adults" });
});

test("Squads: friends who follow each other, invites, chat", async () => {
  await sam.get("/messages");
  assert.match(sam.last.body, /href="\/squads"/);
  await sam.get("/squads");
  await sam.post("/squads/new", { name: "Saturday crew", emoji: "🔥" });
  const squad = sam.last.location;
  assert.match(squad, /^\/squads\/\d+$/);
  await sam.get(squad);
  assert.match(sam.last.body, /🔥 Saturday crew/);
  assert.match(sam.last.body, /<option value="alex">/, "mutual follows can be invited");
  assert.doesNotMatch(sam.last.body, /<option value="jojo">/, "Jo follows Sam but Sam doesn't follow back");
  const nope = await sam.post(`${squad}/invite`, { username: "jojo" });
  assert.equal(nope.status, 400);
  await sam.get(squad);
  await sam.post(`${squad}/invite`, { username: "alex" });

  assert.match(await activity(alex), /invited you to the squad/);
  await alex.get("/squads");
  assert.match(alex.last.body, /invited you to <strong>🔥 Saturday crew/);
  await alex.post(`${squad}/accept`);
  assert.equal(alex.last.location, squad);
  assert.match(await activity(sam), /joined <a href="\/squads\/\d+"><strong>Saturday crew/);

  await alex.get(squad);
  await alex.post(`${squad}/say`, { body: "meet at 6?" });
  await sam.get(squad);
  assert.match(sam.last.body, /meet at 6\?/);
  const json = JSON.parse((await sam.get(`${squad}/messages?after=0`)).body);
  assert.equal(json.at(-1).body, "meet at 6?");
  assert.equal(json.at(-1).mine, false);
  // Jo isn't in it.
  assert.equal((await jo.get(squad)).status, 404);
});

test("IRL streaks: doing something real together this week", async () => {
  const squad = (await sam.get("/squads")).body.match(/href="(\/squads\/\d+)"/)[1];
  const squadId = squad.split("/").pop();
  await app.pool.query("delete from squad_weeks");
  await sam.get(squad);
  assert.match(sam.last.body, /Start your streak/);

  // Alex pulled up to Sam's post in the first test, but before the squad... so check again with posts.
  await share(sam, "At the farmers market");
  await share(alex, "Farmers market haul");
  await sam.get(squad);
  assert.match(sam.last.body, /1-week streak/);
  assert.match(sam.last.body, /This week: you (posted from the same spot|pulled up together)/);
  assert.match(await activity(alex), /🔥 Saturday crew: 1-week streak!/);

  // Streak maths.
  assert.equal(streakFrom(["2026-10-05", "2026-09-28", "2026-09-21"], "2026-10-05"), 3);
  assert.equal(streakFrom(["2026-09-28", "2026-09-21"], "2026-10-05"), 2, "still alive until this week ends");
  assert.equal(streakFrom(["2026-09-21"], "2026-10-05"), 0);

  // Weekend reminder when this week hasn't happened yet (once).
  await app.pool.query("delete from squad_weeks");
  await app.pool.query("insert into squad_weeks (squad_id, week, reason) values ($1, '2026-09-28', 'test')", [squadId]);
  assert.equal((await app.store.claimStreakReminders("2026-10-05", "2026-09-28")).length, 1);
  assert.equal((await app.store.claimStreakReminders("2026-10-05", "2026-09-28")).length, 0);
  assert.match(await activity(sam), /Keep your 1-week streak with Saturday crew/);

  // Only the founder can remove people; anyone can leave.
  await alex.get(squad);
  const samId = (await app.store.userByUsername("sam")).id;
  assert.equal((await alex.post(`${squad}/remove`, { user: samId })).status, 400);
  await alex.get(squad);
  await alex.post(`${squad}/leave`);
  assert.equal((await alex.get(squad)).status, 404);
});
