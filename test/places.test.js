const test = require("node:test");
const assert = require("node:assert/strict");
const { roundLocation, milesBetween, createPlaces } = require("../lib/places");
const { ageOn, checkUsername } = require("../lib/store");

test("locations are rounded to about a mile", () => {
  const exact = { lat: 37.208713, lon: -93.292353 };
  const r = roundLocation(exact.lat, exact.lon);
  assert.ok(milesBetween(exact, r) < 0.75, "never more than ~3/4 mile off");
  // Two spots a couple of hundred yards apart usually land on the same square.
  assert.deepEqual(roundLocation(37.2081, -93.2925), roundLocation(37.2085, -93.2921));
  assert.equal(roundLocation("x", 1), null);
  assert.equal(roundLocation(95, 0), null);
});

test("the nearest town, with real data", () => {
  const places = createPlaces();
  assert.equal(places.nearestTown(37.21, -93.29), "Springfield, MO");
  assert.equal(places.nearestTown(37.04, -93.29), "Nixa, MO");
  assert.equal(places.nearestTown(0, -140), null, "the middle of the Pacific");
});

test("ages and usernames", () => {
  const today = new Date(Date.UTC(2026, 9, 9));
  assert.equal(ageOn("2008-10-09", today), 18);
  assert.equal(ageOn("2008-10-10", today), 17);
  assert.equal(ageOn("2008-02-30", today), null);
  assert.equal(checkUsername("@Sam.Smith"), "sam.smith");
  assert.throws(() => checkUsername("ab"));
  assert.throws(() => checkUsername(".sam"));
  assert.throws(() => checkUsername("sa..m"));
  assert.throws(() => checkUsername("settings"));
});
