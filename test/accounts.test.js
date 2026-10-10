const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, signIn } = require("./helpers");

let app;
test.before(async () => {
  app = await startApp();
});
test.after(() => app.stop());

test("signed out: the welcome page, and everything else asks you to sign in", async () => {
  const b = app.browser();
  let res = await b.get("/");
  assert.equal(res.status, 200);
  assert.match(res.body, /Sign in or join/);
  assert.match(res.body, /<title>Radius<\/title>/);
  assert.match(res.body, /Your world\. Happening now\./);
  assert.match(res.body, /Radius introduces you to the people around you/);
  assert.match(res.body, /invite-only beta/);
  res = await b.get("/settings");
  assert.equal(res.location, "/sign-in");
  assert.equal((await b.get("/terms")).status, 200);
  assert.match((await b.get("/privacy")).body, /never keep or show your exact location/);
});

test("signing in with an emailed code; wrong codes are counted", async () => {
  const b = app.browser();
  await b.get("/sign-in");
  await b.post("/sign-in", { email: " New@Example.com " });
  assert.match(b.last.body, /Check your email/);
  const email = app.emails.at(-1);
  assert.equal(email.to, "new@example.com");
  const code = email.subject.match(/^(\d{6})/)[1];

  for (let i = 0; i < 5; i++) await b.post("/sign-in/code", { email: "new@example.com", code: code === "000000" ? "111111" : "000000" });
  assert.match(b.last.body, /isn&#39;t right/);
  await b.post("/sign-in/code", { email: "new@example.com", code });
  assert.match(b.last.body, /expired/, "five wrong guesses use the code up");

  const fresh = await signIn(app, app.browser(), "new@example.com");
  assert.equal(fresh.location, "/welcome");
});

test("sign-in forms need the page's token", async () => {
  const b = app.browser();
  await b.get("/sign-in");
  const res = await b.request("/sign-in", { form: { _token: "wrong", email: "x@example.com" } });
  assert.equal(res.status, 400);
  assert.equal(app.emails.filter((e) => e.to === "x@example.com").length, 0);
});

test("joining: invite code, 18+, username and terms", async () => {
  const b = app.browser();
  await signIn(app, b, "joiner@example.com");
  // Nothing else works until joining is finished.
  assert.equal((await b.get("/")).location, "/welcome");
  await b.get("/welcome");
  const good = { invite: "", birth_date: "1995-03-04", username: "Joiner_1", display_name: "Joiner One", terms: "on" };

  await b.post("/welcome", good);
  assert.match(b.last.body, /invite code isn&#39;t valid/);

  const invite = await app.store.createInvite({ note: "for joiner" });
  const year = new Date().getUTCFullYear();
  await b.post("/welcome", { ...good, invite: invite.code, birth_date: `${year - 17}-01-01` });
  assert.match(b.last.body, /18 or older/);
  await b.post("/welcome", { ...good, invite: invite.code, terms: "" });
  assert.match(b.last.body, /agree to the terms/);
  await b.post("/welcome", { ...good, invite: invite.code, username: "admin" });
  assert.match(b.last.body, /isn&#39;t available/);
  assert.equal((await app.store.invites()).find((i) => i.id === invite.id).uses, 0, "failed tries don't use the invite");

  await b.post("/welcome", { ...good, invite: invite.code.toLowerCase() });
  assert.equal(b.last.location, "/");
  const user = await app.store.userByUsername("joiner_1");
  assert.equal(user.display_name, "Joiner One");
  assert.ok(user.adult_confirmed_at && user.terms_accepted_at);
  assert.equal((await app.store.invites()).find((i) => i.id === invite.id).uses, 1);

  // The invite was for one person.
  const other = app.browser();
  await signIn(app, other, "second@example.com");
  await other.get("/welcome");
  await other.post("/welcome", { ...good, username: "second", invite: invite.code });
  assert.match(other.last.body, /used up/);
  // And the username is taken.
  const invite2 = await app.store.createInvite({});
  await other.post("/welcome", { ...good, invite: invite2.code });
  assert.match(other.last.body, /username is taken/);
});

test("an invite link fills in the code", async () => {
  const invite = await app.store.createInvite({ note: "link" });
  const b = app.browser();
  await b.get(`/join/${invite.code}`);
  assert.equal(b.last.location, "/sign-in");
  await signIn(app, b, "linked@example.com");
  await b.get("/welcome");
  assert.match(b.last.body, new RegExp(`name="invite"[^>]*value="${invite.code}"`));
});

test("with sign-ups open, no invite is needed", async () => {
  await app.store.setInviteOnly(false);
  const b = app.browser();
  await signIn(app, b, "open@example.com");
  await b.get("/welcome");
  assert.doesNotMatch(b.last.body, /Invite code/);
  await b.post("/welcome", { birth_date: "1980-12-31", username: "opener", display_name: "Open", terms: "on" });
  assert.equal(b.last.location, "/");
  await app.store.setInviteOnly(true);
});

test("banned people are signed out and can't sign back in", async () => {
  const b = app.browser();
  await signIn(app, b, "trouble@example.com");
  const user = (await app.store.users({ search: "trouble" }))[0];
  await app.store.ban(user.id, "spam");
  assert.equal((await b.get("/welcome")).location, "/sign-in");
  const res = await signIn(app, app.browser(), "trouble@example.com");
  assert.equal(res.status, 400);
  assert.match(res.body, /closed for breaking the rules/);
});
