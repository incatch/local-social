const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, join, phonePhoto, multipartMany, OWNER } = require("./helpers");

let app;
let sam;
let alex;
let jo;
let admin;
const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
const as = { headers: { "x-test-admin": OWNER } };

test.before(async () => {
  app = await startApp();
  sam = await join(app, "sam@example.com", "sam", { display_name: "Sam Rivers" });
  alex = await join(app, "alex@example.com", "alex", { display_name: "Alex Stone" });
  jo = await join(app, "jo@example.com", "jojo", { display_name: "Jo March" });
  admin = app.browser();
});
test.after(() => app.stop());

const idOf = async (username) => (await app.store.userByUsername(username)).id;
const settle = () => new Promise((r) => setTimeout(r, 100));

test("finding people: by name or @username, follow from the results, people around you", async () => {
  await sam.get("/");
  assert.match(sam.last.body, /href="\/search" aria-label="Find people"/);
  await sam.get("/search?q=al");
  assert.match(sam.last.body, /Alex Stone/);
  assert.doesNotMatch(sam.last.body, /Jo March/);
  assert.match((await sam.get("/search?q=MARCH")).body, /@jojo/, "names, any case");
  assert.match((await sam.get("/search?q=%40alex")).body, /Alex Stone/, "@username works");
  assert.match((await sam.get("/search?q=%25")).body, /Nobody called/, "% is just a character");
  assert.doesNotMatch((await sam.get("/search?q=sam")).body, /class="person"/, "not yourself");

  // Typing swaps in just the results.
  const partial = await sam.get("/search?partial=1&q=al");
  assert.match(partial.body, /Alex Stone/);
  assert.doesNotMatch(partial.body, /<html/);

  // Follow straight from the results, and land back on them.
  await sam.get("/search?q=al");
  await sam.post("/@alex/follow", { back: "/search?q=al" });
  assert.equal(sam.last.location, "/search?q=al");
  assert.match((await sam.get("/search?q=al")).body, /Following/);
  await sam.post("/@alex/follow", { back: "https://evil.example" });
  assert.equal(sam.last.location, "/@alex");

  // No search yet: people around you that you don't follow.
  for (const b of [sam, jo]) {
    await b.get("/");
    await b.post("/feed/location", SPRINGFIELD);
  }
  await sam.get("/search");
  assert.match(sam.last.body, /People around you/);
  assert.match(sam.last.body, /Jo March/);

  // People who block you can't be found.
  await jo.get("/@sam");
  await jo.post("/@sam/block");
  assert.doesNotMatch((await sam.get("/search?q=jo")).body, /Jo March/);
  assert.doesNotMatch((await sam.get("/search")).body, /Jo March/);
  await jo.get("/settings");
  await jo.post("/@sam/unblock", { back: "/settings" });
});

test("feedback: from Settings or your profile, to Admin → Beta, with an email to the owner", async () => {
  await sam.get("/settings");
  assert.match(sam.last.body, /Send feedback/);
  await sam.get("/@sam");
  assert.match(sam.last.body, /href="\/feedback\?from=\/@sam"/);

  await sam.get("/feedback?from=/@sam");
  assert.match(sam.last.body, /Something&#39;s wrong/);
  const empty = await sam.post("/feedback", { from: "/@sam", kind: "idea", body: " " });
  assert.equal(empty.status, 400);
  assert.match(empty.body, /a few words/);
  const before = app.emails.length;
  await sam.get("/feedback?from=/@sam");
  const res = await sam.post("/feedback", { from: "/@sam", kind: "problem", body: "The map button does nothing on my iPhone" });
  assert.equal(res.status, 200);
  assert.match(res.body, /Thank you/);
  assert.match(res.body, /href="\/@sam"/);
  const alert = app.emails.slice(before).find((e) => /Radius feedback/.test(e.subject));
  assert.ok(alert, "the owner hears about it");
  assert.match(alert.text, /\/admin\/beta#feedback/);

  // A "from" that isn't one of our pages is dropped.
  await sam.get("/feedback?from=//evil.example");
  assert.doesNotMatch(sam.last.body, /evil\.example/);

  await admin.request("/admin/beta", as);
  assert.match(admin.last.body, /The map button does nothing/);
  assert.match(admin.last.body, /on \/@sam/);
  const id = admin.last.body.match(/\/admin\/beta\/feedback\/(\d+)\/done/)[1];
  await admin.request(`/admin/beta/feedback/${id}/done`, { ...as, form: { _token: admin.token() } });
  await admin.request("/admin/beta", as);
  assert.doesNotMatch(admin.last.body, /The map button does nothing/);
  await admin.request("/admin/beta?show=done", as);
  assert.match(admin.last.body, /The map button does nothing/);
});

test("email nudges: waiting messages (once, never what they say), and turning them off", async () => {
  await jo.get("/@alex");
  await jo.post("/@alex/message");
  const chat = jo.last.location;
  await jo.get(chat);
  await jo.post(chat, { body: "secret plans for saturday" });
  await settle();

  // Alex is still around and the message is new: no email yet.
  let before = app.emails.length;
  await app.runNudges();
  assert.equal(app.emails.length, before);

  // An hour later, still unread.
  const alexId = await idOf("alex");
  await app.pool.query("update users set last_seen_at = now() - interval '2 hours' where id = $1", [alexId]);
  await app.pool.query("update messages set created_at = now() - interval '30 minutes'");
  await app.runNudges();
  const sent = app.emails.slice(before).filter((e) => e.to === "alex@example.com");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "Jo March wants to message you");
  assert.doesNotMatch(sent[0].text + sent[0].html, /secret plans/);
  assert.match(sent[0].text, /\/messages/);
  assert.match(sent[0].headers["List-Unsubscribe"], /\/emails\/off\//);

  // Not again for the same messages.
  before = app.emails.length;
  await app.runNudges();
  assert.equal(app.emails.length, before);

  // The link in the email turns them off (no sign-in needed).
  const off = sent[0].text.match(/Turn them off: \S+(\/emails\/off\/\S+)/)[1];
  const visitor = app.browser();
  await visitor.get(off);
  assert.match(visitor.last.body, /Turn off emails\?/);
  await visitor.request(off, { method: "POST" });
  assert.match(visitor.last.body, /Emails turned off/);
  assert.equal((await app.store.user(alexId)).email_nudges, false);
  assert.equal((await visitor.get(off.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).status, 404);

  // And back on in Settings.
  await alex.get("/settings");
  assert.doesNotMatch(alex.last.body, /name="on" checked/);
  await alex.post("/settings/emails", { on: "on" });
  assert.equal((await app.store.user(alexId)).email_nudges, true);
  await alex.get(alex.last.location);
  assert.match(alex.last.body, /We&#39;ll email you/);
});

test("email nudges: a weekly what's new around you, only when there's something new", async () => {
  const joId = await idOf("jojo");
  await app.pool.query("update users set created_at = now() - interval '10 days', last_seen_at = now() - interval '4 days' where id = $1", [joId]);
  let before = app.emails.length;
  await app.runNudges();
  assert.equal(app.emails.slice(before).filter((e) => e.to === "jo@example.com").length, 0, "nothing new, no email");

  // Sam posts around Springfield.
  await app.pool.query("update users set digest_sent_at = null where id = $1", [joId]);
  await sam.get("/new");
  const up = multipartMany({ caption: "Farmers market is packed", with_location: "on", ...SPRINGFIELD }, "photos", [await phonePhoto()]);
  await sam.request(`/new?_token=${sam.token()}`, { body: up.body, headers: up.headers });
  before = app.emails.length;
  await app.runNudges();
  const digest = app.emails.slice(before).find((e) => e.to === "jo@example.com");
  assert.ok(digest);
  assert.equal(digest.subject, "1 new post around Springfield");
  assert.match(digest.text, /See what's happening/);

  // Once a week at most; and the owner can switch them all off.
  before = app.emails.length;
  await app.runNudges();
  assert.equal(app.emails.length, before);
  await admin.request("/admin/beta", as);
  assert.match(admin.last.body, /Email nudges/);
  await admin.request("/admin/beta/emails", { ...as, form: { _token: admin.token(), on: "false" } });
  assert.equal((await app.store.settings()).email_nudges_enabled, false);
  await app.pool.query("update users set digest_sent_at = null, messages_nudged_at = null");
  await app.runNudges();
  assert.equal(app.emails.length, before);
});

test("Admin → Beta: who's here, the last 14 days, busiest towns", async () => {
  await settle();
  await admin.request("/admin/beta", as);
  const body = admin.last.body;
  assert.match(body, /How the beta is going/);
  assert.match(body, /<b>3<\/b><span>members/);
  assert.match(body, /<b>3<\/b><span>here today/);
  assert.match(body, /Springfield, MO/);
  assert.equal((body.match(/<tr><td>/g) || []).length, 14 + 1, "14 days and one town");
  // Messages are counted when sent (they disappear later).
  assert.match(body, /<td>[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+<\/td><td>3<\/td><td>2<\/td><td>1<\/td><td>0<\/td><td>1<\/td>/, "jo's join date was moved back 10 days");
  assert.match(admin.last.body, /href="\/admin\/beta">Beta<\/a>/);
});
