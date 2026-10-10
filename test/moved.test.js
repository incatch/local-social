const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, join } = require("./helpers");

let app;
let sam;
test.before(async () => {
  app = await startApp();
  sam = await join(app, "sam@example.com", "sam");
});
test.after(() => app.stop());

const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
const NIXA = { lat: "37.0434", lon: "-93.2944" }; // ~12 miles
const TORONTO = { lat: "43.70", lon: "-79.40" };
const check = async (where) => JSON.parse((await sam.get(`/location/check?lat=${where.lat}&lon=${where.lon}`)).body);

test("nothing to compare with yet: no prompt", async () => {
  assert.deepEqual(await check(TORONTO), { moved: false, town: null });
});

test("a short trip doesn't prompt; moving more than 50 miles does, and Update fixes both spots", async () => {
  await sam.get("/settings");
  await sam.post("/settings/area", SPRINGFIELD);
  await sam.get("/");
  await sam.post("/feed/location", SPRINGFIELD);
  assert.equal((await check(NIXA)).moved, false);

  const far = await check(TORONTO);
  assert.equal(far.moved, true);
  assert.equal(far.town, "Toronto, CA");

  await sam.get("/");
  assert.match(sam.last.body, /data-token="/);
  const res = await sam.post("/location/update", TORONTO);
  assert.equal(res.status, 200);
  const user = await app.store.userByUsername("sam");
  assert.equal(user.area_name, "Toronto, CA");
  assert.ok(Math.abs(user.feed_lat - 43.7) < 0.02);
  assert.equal((await check(TORONTO)).moved, false);
});

test("updating needs the page's token", async () => {
  const res = await sam.request("/location/update", { form: { _token: "nope", ...SPRINGFIELD } });
  assert.equal(res.status, 400);
});
