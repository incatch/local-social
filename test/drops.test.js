const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, join, phonePhoto, multipartMany } = require("./helpers");
const { parse } = require("../lib/public-places");

let app;
let sam;
let alex;
let jo;
const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
const AT_PARK = { lat: "37.208850", lon: "-93.292450" };
const AT_SCHOOL = { lat: "37.190200", lon: "-93.280200" };

test.before(async () => {
  app = await startApp();
  sam = await join(app, "sam@example.com", "sam", { display_name: "Sam Rivers" });
  alex = await join(app, "alex@example.com", "alex", { display_name: "Alex Stone" });
  jo = await join(app, "jo@example.com", "jojo", { display_name: "Jo March" });
  for (const b of [sam, alex, jo]) {
    await b.get("/");
    await b.post("/feed/location", SPRINGFIELD);
  }
});
test.after(() => app.stop());

async function leaveDrop(b, fields, photo = false) {
  await b.get("/drops/new");
  const up = multipartMany(fields, "photo", photo ? [await phonePhoto()] : []);
  return b.request(`/drops/new?_token=${b.token()}`, { body: up.body, headers: up.headers });
}

test("public places: parks, cafés and landmarks count; bars don't; schools are flagged", () => {
  const found = parse({
    elements: [
      { type: "way", id: 1, center: { lat: 1, lon: 2 }, tags: { leisure: "park", name: "A Park" } },
      { type: "node", id: 2, lat: 1, lon: 2, tags: { amenity: "bar", name: "A Bar" } },
      { type: "node", id: 3, lat: 1, lon: 2, tags: { amenity: "school", name: "A School" } },
      { type: "node", id: 4, lat: 1, lon: 2, tags: { leisure: "park" } },
    ],
  });
  assert.deepEqual(found.map((p) => [p.name, p.school]), [["A Park", false], ["A School", true]]);
});

test("leaving a Drop: only at a public place you're at, never near a school", async () => {
  await sam.get("/drops");
  assert.match(sam.last.body, /Leave a Drop here/);
  const spots = JSON.parse((await sam.get(`/drops/spots?lat=${AT_PARK.lat}&lon=${AT_PARK.lon}`)).body);
  assert.equal(spots.school, false);
  assert.deepEqual(spots.spots.map((s) => s.name), ["Park Central Square", "Classic Rock Coffee"]);
  const calls = app.overpassCalls.n;
  await sam.get(`/drops/spots?lat=${AT_PARK.lat}&lon=${AT_PARK.lon}`);
  assert.equal(app.overpassCalls.n, calls, "looked up once, then remembered");
  assert.equal(JSON.parse((await sam.get(`/drops/spots?lat=${AT_SCHOOL.lat}&lon=${AT_SCHOOL.lon}`)).body).school, true);

  assert.equal((await leaveDrop(sam, { ...AT_PARK, spot: "node/3", note: "hi" })).status, 400, "a bar isn't a Drop spot");
  const school = await leaveDrop(sam, { ...AT_SCHOOL, spot: "node/5", note: "hi" });
  assert.equal(school.status, 400);
  assert.match(school.body, /near a school/);
  assert.equal((await leaveDrop(sam, { ...AT_PARK, spot: "way/1", note: "" })).status, 400, "needs a photo or a note");

  const res = await leaveDrop(sam, { ...AT_PARK, spot: "way/1", note: "Best bench in town. Sit here at sunset 🌅" }, true);
  assert.match(res.location, /^\/drops\/\d+$/);
  const drop = (await app.pool.query("select * from drops order by id desc limit 1")).rows[0];
  assert.equal(drop.place_name, "Park Central Square");
  assert.equal(drop.lat, 37.2089, "saved at the park's own spot, not where Sam stood");
  assert.ok(drop.photo_key);
});

test("finding a Drop: locked until you're there; nobody learns who found it", async () => {
  const id = (await app.pool.query("select id from drops order by id desc limit 1")).rows[0].id;
  await alex.get("/");
  assert.match(alex.last.body, /href="\/drops">📍 Drops <b>1<\/b>/);
  await alex.get("/drops");
  assert.match(alex.last.body, /Park Central Square/);
  assert.doesNotMatch(alex.last.body, /Best bench/);
  await alex.get(`/drops/${id}`);
  assert.match(alex.last.body, /🔒/);
  assert.doesNotMatch(alex.last.body, /Best bench/);
  assert.doesNotMatch(alex.last.body, /\/media\//, "no photo before it's found");

  const far = await alex.post(`/drops/${id}/open`, { lat: "37.2200", lon: "-93.2923" });
  assert.equal(far.status, 400);
  assert.match(far.body, /Not quite there: you&#39;re about 1\.\d miles away|Not quite there/);
  await alex.get(`/drops/${id}`);
  await alex.post(`/drops/${id}/open`, { lat: "37.208950", lon: "-93.292400" });
  assert.equal(alex.last.location, `/drops/${id}`);
  await alex.get(`/drops/${id}`);
  assert.match(alex.last.body, /Best bench in town/);
  assert.match(alex.last.body, /Found it/);
  assert.match(alex.last.body, /found by 1 person/);

  await sam.get("/activity");
  assert.match(sam.last.body, /Someone found your Drop at Park Central Square/);
  assert.doesNotMatch(sam.last.body, /alex/i);
  await alex.get("/drops");
  assert.match(alex.last.body, /Your stamps · 1 found/);

  // Off in Admin → New features: gone.
  await app.store.setFeatures({ feature_drops: "off" });
  assert.equal((await alex.get("/drops")).status, 404);
  await app.store.setFeatures({ feature_drops: "adults" });
});

test("Where It's At: crowds of adults, at least 30 minutes old, never one person", async () => {
  const post = async (b, color) => {
    await b.get("/new");
    const up = multipartMany({ caption: "busy here", with_location: "on", ...SPRINGFIELD }, "photos", [await phonePhoto({ color })]);
    await b.request(`/new?_token=${b.token()}`, { body: up.body, headers: up.headers });
  };
  await post(sam, "#4a7");
  await post(alex, "#47a");
  await post(jo, "#a74");
  const data = async () => JSON.parse((await sam.get("/where/data")).body);
  assert.deepEqual(await data(), [], "too fresh: always at least 30 minutes behind");

  await app.pool.query("update posts set created_at = now() - interval '1 hour'");
  const spots = await data();
  assert.equal(spots.length, 1);
  assert.equal(spots[0].people, 3);
  assert.equal(spots[0].town, "Springfield");
  assert.equal(spots[0].shown.length, 3);

  // Teens' posts never count, so two people isn't a crowd.
  await app.pool.query("update users set teen_until = current_date + 365 where username = 'jojo'");
  assert.deepEqual(await data(), []);
  await app.store.setFeatures({ heat_min_people: "2" });
  assert.equal((await data()).length, 1);
  await app.pool.query("update users set teen_until = null where username = 'jojo'");

  await sam.get("/where");
  assert.match(sam.last.body, /data-where-map/);
  assert.match(sam.last.body, /\/static\/vendor\/leaflet\.js/);
  assert.equal((await sam.get("/static/vendor/leaflet.js")).status, 200);
  await sam.get("/");
  assert.match(sam.last.body, /Where it&#39;s at|Where it's at/);
});
