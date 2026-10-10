const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, join, phonePhoto, multipartMany } = require("./helpers");
const { momentTitle } = require("../lib/moment-store");

let app;
const people = [];
const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
const NEARBY_SPOT = { lat: "37.2095", lon: "-93.2930" }; // same rounded spot
const NIXA = { lat: "37.0434", lon: "-93.2944" };

test.before(async () => {
  app = await startApp();
  for (const name of ["ana", "ben", "cal", "dee"]) people.push(await join(app, `${name}@example.com`, name));
  await people[3].get("/");
  await people[3].post("/feed/location", SPRINGFIELD);
});
test.after(() => app.stop());

async function share(b, caption, where = SPRINGFIELD) {
  await b.get("/new");
  const up = multipartMany({ caption, with_location: "on", ...where }, "photos", [await phonePhoto()]);
  const res = await b.request(`/new?_token=${b.token()}`, { body: up.body, headers: up.headers });
  return res.location.split("/").pop();
}

test("titles read like a moment", () => {
  assert.equal(momentTitle(new Date("2026-10-09T23:30:00Z"), "Springfield, MO", "America/Chicago"), "Friday evening in Springfield");
  assert.equal(momentTitle(new Date("2026-10-10T14:00:00Z"), "Nixa, MO", "America/Chicago"), "Saturday morning in Nixa");
});

test("three people posting from the same spot make a Moment; later posts join it", async () => {
  const [ana, ben, cal, dee] = people;
  await share(ana, "Kickoff!");
  await share(ana, "Second quarter");
  await share(ben, "Go team", NEARBY_SPOT);
  assert.equal((await app.pool.query("select count(*)::int as n from moments")).rows[0].n, 0, "two people isn't a Moment yet");
  await share(cal, "Halftime show");
  await share(people[0], "far away", NIXA);
  const moments = (await app.pool.query("select * from moments")).rows;
  assert.equal(moments.length, 1);
  const id = moments[0].id;
  assert.match(moments[0].title, / in Springfield$/);
  const inIt = (await app.pool.query("select p.caption from moment_posts mp join posts p on p.id = mp.post_id where mp.moment_id = $1 order by p.id", [id])).rows.map((r) => r.caption);
  assert.deepEqual(inIt, ["Kickoff!", "Second quarter", "Go team", "Halftime show"]);

  // Everyone in it hears about it.
  await ana.get("/activity");
  assert.match(ana.last.body, /Your photo is part of a Moment/);
  // It's at the top of Nearby, and has its own page.
  await dee.get("/?tab=nearby");
  assert.match(dee.last.body, /Happening now/);
  assert.match(dee.last.body, /3 people · 4 posts/);
  await dee.get(`/m/${id}`);
  assert.match(dee.last.body, /Halftime show/);
  // A later post from the same spot joins; the post page links back.
  const late = await share(dee, "Final score!");
  await dee.get(`/p/${late}`);
  assert.match(dee.last.body, /Part of <strong>/);
  await dee.get(`/m/${id}`);
  assert.match(dee.last.body, /4 people · 5 posts/);
});

test("political posts don't join Moments", async () => {
  const id = await share(people[1], "Vote for Smith!");
  assert.equal((await app.store.momentOfPost(id)), null);
});
