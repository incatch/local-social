const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, join, phonePhoto, multipartMany, OWNER } = require("./helpers");

let app;
let poster;
let viewer;
const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
const NIXA = { lat: "37.0434", lon: "-93.2944" }; // ~12 miles

test.before(async () => {
  app = await startApp();
  poster = await join(app, "poster@example.com", "poster");
  viewer = await join(app, "viewer@example.com", "viewer");
  await viewer.get("/");
  await viewer.post("/feed/location", SPRINGFIELD);
  await viewer.get("/");
  await viewer.post("/feed/radius", { miles: "25" });
});
test.after(() => app.stop());

async function share(b, caption, where = SPRINGFIELD) {
  await b.get("/new");
  const up = multipartMany({ caption, with_location: "on", ...where }, "photos", [await phonePhoto()]);
  const res = await b.request(`/new?_token=${b.token()}`, { body: up.body, headers: up.headers });
  return res.location.split("/").pop();
}
async function like(b, id) {
  await b.get(`/p/${id}`);
  await b.post(`/p/${id}/like`);
}

test("ripples: a post reaches further as people like it, and the poster hears about it", async () => {
  const id = await share(poster, "Nixa sunrise", NIXA);
  assert.doesNotMatch((await viewer.get("/?tab=nearby")).body, /Nixa sunrise/, "12 miles away, still in its first 10-mile ring");
  const fans = [];
  for (const name of ["fan1", "fan2", "fan3"]) {
    const fan = await join(app, `${name}@example.com`, name);
    fans.push(fan);
    await like(fan, id);
  }
  await viewer.get("/?tab=nearby");
  assert.match(viewer.last.body, /Nixa sunrise/);
  assert.match(viewer.last.body, /Rippled to 25 mi/);
  await poster.get("/activity");
  assert.match(poster.last.body, /Your post rippled out to 25 miles/);
  // Unliking and liking again doesn't repeat the news.
  await like(fans[0], id);
  await like(fans[0], id);
  const { rows } = await app.pool.query("select count(*)::int as n from notifications where kind = 'ripple'");
  assert.equal(rows[0].n, 1);
});

test("new since you last looked, and you're all caught up", async () => {
  await viewer.get("/?tab=nearby");
  assert.match(viewer.last.body, /You&#39;re all caught up|You're all caught up/);
  assert.match(viewer.last.body, /everything within 25 miles from the last 14 days/);
  await share(poster, "Fresh one");
  await share(poster, "Another fresh one");
  await viewer.get("/?tab=nearby");
  assert.match(viewer.last.body, /2 new nearby since you last looked/);
  await viewer.get("/?tab=nearby");
  assert.doesNotMatch(viewer.last.body, /new nearby since you last looked/);
});

test("old posts leave Nearby after the window; this week in past years shows at the end", async () => {
  const old = await share(poster, "Last year's fair");
  await app.pool.query("update posts set created_at = now() - interval '365 days' where id = $1", [old]);
  const mid = await share(poster, "Last month's thing");
  await app.pool.query("update posts set created_at = now() - interval '30 days' where id = $1", [mid]);
  await viewer.get("/?tab=nearby");
  assert.doesNotMatch(viewer.last.body, /Last month&#39;s thing/);
  assert.match(viewer.last.body, /Around here, a year ago/);
  assert.match(viewer.last.body, new RegExp(`href="/p/${old}"`));
});

test("the owner sets the rings and the window in Admin → Nearby rules", async () => {
  const admin = app.browser();
  const as = { headers: { "x-test-admin": OWNER } };
  await admin.request("/admin/nearby", as);
  assert.match(admin.last.body, /Posts ripple out as people like them/);
  await admin.request("/admin/nearby", {
    ...as,
    form: { _token: admin.token(), nearby_politics_filter: "on", nearby_ai_filter: "on", taken_here_badge: "on", taken_here_hours: "24", taken_here_miles: "5", ripple_start_miles: "5", ripple_2_at: "2", ripple_2_miles: "15", ripple_3_at: "5", ripple_3_miles: "40", nearby_days: "60" },
  });
  const s = await app.store.settings();
  assert.equal(s.ripples_enabled, false, "the box was unticked");
  assert.equal(s.ripple_start_miles, 5);
  assert.equal(s.nearby_days, 60);
  await viewer.get("/?tab=nearby");
  assert.match(viewer.last.body, /Last month&#39;s thing/, "60 days now");
});
