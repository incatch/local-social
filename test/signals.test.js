const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, join, OWNER } = require("./helpers");

let app;
let ana;
let ben;
let far;
const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
const KC = { lat: "39.0997", lon: "-94.5786" };

async function locate(b, where, miles = "10") {
  await b.get("/");
  await b.post("/feed/location", where);
  await b.get("/");
  await b.post("/feed/radius", { miles });
}
async function send(b, form) {
  await b.get(`/around/new?kind=${form.kind}`);
  return b.post("/around/new", form);
}
const sid = (res) => res.location.split("/").pop();

test.before(async () => {
  app = await startApp();
  ana = await join(app, "ana@example.com", "ana");
  ben = await join(app, "ben@example.com", "ben");
  far = await join(app, "far@example.com", "faraway");
  await locate(ana, SPRINGFIELD);
  await locate(ben, SPRINGFIELD);
  await locate(far, KC);
});
test.after(() => app.stop());

test("ask nearby: neighbours answer, the asker thanks the best answer", async () => {
  const res = await send(ana, { kind: "ask", body: "Why are there sirens on Glenstone?" });
  const id = sid(res);
  // On Nearby it's one slim "Around you" bar, not a card in the feed.
  await ben.get("/?tab=nearby");
  assert.match(ben.last.body, /class="around-bar"/);
  assert.match(ben.last.body, /sirens on Glenstone/);
  // Out of range: not in their Around you (though a shared link still opens).
  await far.get("/around");
  assert.doesNotMatch(far.last.body, /Glenstone/);

  await ben.get(`/s/${id}`);
  await ben.post(`/s/${id}/reply`, { body: "Fire drill at the hospital" });
  await ana.get("/activity");
  assert.match(ana.last.body, /answered your question/);
  await ana.get(`/s/${id}`);
  const replyId = (await app.pool.query("select id from signal_replies limit 1")).rows[0].id;
  await ana.post(`/s/${id}/thank/${replyId}`);
  await ben.get("/activity");
  assert.match(ben.last.body, /thanked you for your answer/);
  // Only the asker can thank.
  await ben.get(`/s/${id}`);
  assert.equal((await ben.post(`/s/${id}/thank/${replyId}`)).status, 400);
});

test("plans: a time, 'I'm in', and it disappears after", async () => {
  const at = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  const id = sid(await send(ana, { kind: "plan", body: "Pickup basketball at Phelps Grove", plan_at_iso: at }));
  await ben.get("/around?kind=plan");
  assert.match(ben.last.body, /Pickup basketball/);
  await ben.post(`/s/${id}/join`);
  await ben.get(`/s/${id}`);
  assert.match(ben.last.body, /You're in|You&#39;re in/);
  assert.match(ben.last.body, /1 in/);
  await ana.get("/activity");
  assert.match(ana.last.body, /is in for/);
  await app.pool.query("update signals set expires_at = now() - interval '1 minute' where id = $1", [id]);
  assert.equal((await ben.get(`/s/${id}`)).status, 404);
  // A time in the past is refused; so is one more than a week away.
  const past = await send(ana, { kind: "plan", body: "Yesterday", plan_at_iso: new Date(Date.now() - 86400000).toISOString() });
  assert.match(past.body, /already passed/);
});

test("polls: vote and see results", async () => {
  const id = sid(await send(ana, { kind: "poll", body: "Best tacos in town?", option0: "Taco Bus", option1: "Jose's", option2: "" }));
  await ben.get(`/s/${id}`);
  assert.doesNotMatch(ben.last.body, /%<\/b>/, "no results before voting");
  await ben.post(`/s/${id}/vote`, { choice: "1" });
  await ben.get(`/s/${id}`);
  assert.match(ben.last.body, /100%/);
  assert.match(ben.last.body, /1 vote</);
  const bad = await send(ana, { kind: "poll", body: "Only one?", option0: "Yes" });
  assert.match(bad.body, /at least two choices/);
});

test("lost & found stays 3 days; politics isn't allowed; it can be reported and removed", async () => {
  const id = sid(await send(ben, { kind: "lost", body: "Lost: grey cat, blue collar, near Battlefield" }));
  const { rows } = await app.pool.query("select round(extract(epoch from expires_at - created_at) / 3600) as hours from signals where id = $1", [id]);
  assert.equal(Number(rows[0].hours), 72);
  const political = await send(ana, { kind: "ask", body: "Who are you voting for in the election?" });
  assert.match(political.body, /it can(&#39;|.)t be political/);

  await ana.get(`/report?type=signal&id=${id}`);
  await ana.post("/report", { type: "signal", id, reason: "spam" });
  const admin = app.browser();
  const as = { headers: { "x-test-admin": OWNER } };
  await admin.request("/admin/moderation", as);
  assert.match(admin.last.body, /Around-you signal from @ben/);
  const report = (await app.store.openReports()).find((r) => r.target_type === "signal");
  await admin.request(`/admin/moderation/report/${report.id}/remove`, { ...as, form: { _token: admin.token() } });
  assert.equal((await ana.get(`/s/${id}`)).status, 404);
  const [item] = await app.store.moderatedItems();
  assert.equal(item.source, "signal");
});

test("the new-post page offers signals, quietly", async () => {
  await ana.get("/new");
  assert.match(ana.last.body, /Or send to people around you/);
  assert.match(ana.last.body, /\/around\/new\?kind=plan/);
});
