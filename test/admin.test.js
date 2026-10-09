const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, join, OWNER } = require("./helpers");

let app;
let admin;
test.before(async () => {
  app = await startApp();
  admin = app.browser();
});
test.after(() => app.stop());
const as = { headers: { "x-test-admin": OWNER } };
const adminGet = (p) => admin.request(p, as);
const adminPost = (p, form) => admin.request(p, { ...as, form: { _token: admin.token(), ...form } });

test("admin needs the household sign-in and an admin's email", async () => {
  assert.equal((await app.browser().get("/admin")).status, 401);
  assert.equal((await app.browser().request("/admin", { headers: { "x-test-admin": "someone@example.com" } })).status, 403);
  const res = await adminGet("/admin");
  assert.equal(res.status, 200);
  assert.match(res.body, /Invite only/);
});

test("invites: create, see the link, revoke", async () => {
  await adminGet("/admin/invites");
  await adminPost("/admin/invites", { note: "Sam from work", max_uses: "3" });
  assert.equal(admin.last.location, "/admin/invites?done=invite");
  const [invite] = await app.store.invites();
  assert.equal(invite.note, "Sam from work");
  assert.equal(invite.max_uses, 3);
  assert.match(invite.code, /^[A-HJ-NP-Z2-9]{8}$/);
  await adminGet("/admin/invites");
  assert.match(admin.last.body, new RegExp(`https://social.example.test/join/${invite.code}`));
  await adminPost(`/admin/invites/${invite.id}/revoke`, {});
  assert.ok((await app.store.invites())[0].revoked_at);
  await adminGet("/admin/invites");
  await adminPost("/admin/invites", { max_uses: "0" });
  assert.equal(admin.last.status, 400);
});

test("forms need the admin token", async () => {
  const res = await admin.request("/admin/invite-only", { ...as, form: { _token: "x", on: "false" } });
  assert.equal(res.status, 403);
  assert.equal((await app.store.settings()).invite_only, true);
});

test("opening sign-ups, and closing them again", async () => {
  await adminGet("/admin");
  await adminPost("/admin/invite-only", { on: "false" });
  assert.equal((await app.store.settings()).invite_only, false);
  await adminGet("/admin");
  assert.match(admin.last.body, /Anyone 18\+ can join/);
  await adminPost("/admin/invite-only", { on: "true" });
  assert.equal((await app.store.settings()).invite_only, true);
});

test("users: search, ban (signs them out), unban", async () => {
  const pat = await join(app, "pat@example.com", "pat");
  await adminGet("/admin/users?q=pat");
  assert.match(admin.last.body, /@pat/);
  assert.match(admin.last.body, /pat@example.com/);
  const user = await app.store.userByUsername("pat");
  await adminPost(`/admin/users/${user.id}/ban`, { reason: "" });
  assert.equal(admin.last.status, 400);
  await adminGet("/admin/users");
  await adminPost(`/admin/users/${user.id}/ban`, { reason: "harassment" });
  assert.equal((await app.store.userByUsername("pat")).status, "banned");
  assert.match((await pat.get("/")).body, /Sign in or join/);
  await adminGet("/admin/users");
  assert.match(admin.last.body, /harassment/);
  await adminPost(`/admin/users/${user.id}/unban`, {});
  assert.equal((await app.store.userByUsername("pat")).status, "active");
});
