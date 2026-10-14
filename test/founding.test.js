const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, join, signIn, OWNER } = require("./helpers");

let app;
let admin;
const as = { headers: { "x-test-admin": OWNER } };

test.before(async () => {
  app = await startApp();
  await join(app, "first@example.com", "first");
  admin = app.browser();
});
test.after(() => app.stop());

test("invite only: the front page offers the waitlist, and the owner can invite from it", async () => {
  const visitor = app.browser();
  await visitor.get("/");
  assert.match(visitor.last.body, /Join the waitlist/);
  assert.equal((await visitor.request("/waitlist", { form: { email: "nope" } })).status, 400);
  await visitor.get("/?utm_source=tiktok");
  await visitor.request("/waitlist", { form: { email: "Wait@Example.com" } });
  assert.match(visitor.last.body, /You&#39;re on the list|You're on the list/);

  await admin.request("/admin/invites", as);
  assert.match(admin.last.body, /wait@example\.com/);
  assert.match(admin.last.body, /tiktok/);
  const id = admin.last.body.match(/\/admin\/waitlist\/(\d+)\/invite/)[1];
  const before = app.emails.length;
  await admin.request(`/admin/waitlist/${id}/invite`, { ...as, form: { _token: admin.token() } });
  const mail = app.emails.slice(before).find((e) => e.to === "wait@example.com");
  assert.ok(mail);
  assert.match(mail.text, /\/join\/[A-Z0-9]+/);
  await admin.request("/admin/invites", as);
  assert.match(admin.last.body, /Waitlist \(0\)/);
});

test("founding spots: anyone can join without an invite until they're full; ads are counted", async () => {
  await admin.request("/admin", as);
  assert.match(admin.last.body, /Founding members/);
  await admin.request("/admin/founding", { ...as, form: { _token: admin.token(), founding_open: "on", founding_limit: "3", founding_area: "Springfield" } });
  const s = await app.store.settings();
  assert.equal(s.founding_open, true);
  assert.equal(s.founding_limit, 3);

  // An ad brings someone in.
  const ad = app.browser();
  await ad.get("/?utm_source=Instagram&utm_campaign=springfield-fall");
  assert.match(ad.last.body, /<b>2<\/b><span>of 3 founding spots left in Springfield/);
  assert.match(ad.last.body, /Claim a founding spot/);
  await signIn(app, ad, "ad@example.com");
  await ad.get("/welcome");
  assert.doesNotMatch(ad.last.body, /Invite code/, "no invite needed");
  await ad.post("/welcome", { birth_date: "1995-04-01", username: "fromad", display_name: "From Ad", terms: "on" });
  assert.equal(ad.last.location, "/hello");
  await ad.get("/hello");
  assert.match(ad.last.body, /You&#39;re founding member #2 of 3|You're founding member #2 of 3/);
  assert.equal((await app.store.userByUsername("fromad")).signup_source, "instagram/springfield-fall");
  await admin.request("/admin/beta", as);
  assert.match(admin.last.body, /instagram\/springfield-fall/);

  // The founding badge goes to the first 3.
  await ad.get("/badges");
  assert.match(ad.last.body, /class="earned"><span class="badge-emoji">🌱/);

  // The last spot, then it's full: invites again, and the waitlist.
  const third = app.browser();
  await signIn(app, third, "third@example.com");
  await third.get("/welcome");
  await third.post("/welcome", { birth_date: "1990-01-01", username: "third", display_name: "Third", terms: "on" });
  assert.equal(third.last.location, "/hello");
  const late = app.browser();
  await late.get("/");
  assert.match(late.last.body, /All 3 founding spots are taken/);
  await signIn(app, late, "late@example.com");
  await late.get("/welcome");
  assert.match(late.last.body, /Invite code/);
  assert.match(late.last.body, /Put me on the waitlist/);
  await late.request("/waitlist", { form: { _token: late.token() } });
  assert.match(late.last.body, /You&#39;re on the list|You're on the list/);
  assert.ok((await app.store.waitlist()).some((w) => w.email === "late@example.com"));
});
