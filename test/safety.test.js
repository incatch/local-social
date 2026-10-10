const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { startApp, join, phonePhoto, multipart, multipartMany, OWNER } = require("./helpers");

let app;
let sam;
let alex;
let jo;
let admin;
test.before(async () => {
  app = await startApp();
  sam = await join(app, "sam@example.com", "sam");
  alex = await join(app, "alex@example.com", "alex");
  jo = await join(app, "jo@example.com", "jojo");
  admin = app.browser();
});
test.after(() => app.stop());

const as = { headers: { "x-test-admin": OWNER } };
const adminGet = (p) => admin.request(p, as);
const adminPost = (p, form = {}) => admin.request(p, { ...as, form: { _token: admin.token(), ...form } });
const SPRINGFIELD = { with_location: "on", lat: "37.2087", lon: "-93.2923" };

async function share(b, { caption = "", color = "#4a7" } = {}) {
  await b.get("/new");
  const up = multipartMany({ caption, ...SPRINGFIELD }, "photos", [await phonePhoto({ color })]);
  return b.request(`/new?_token=${b.token()}`, { body: up.body, headers: up.headers });
}
const postId = (res) => res.location.split("/").pop();
async function report(b, query, form) {
  await b.get(`/report?${query}`);
  const hiddenFields = Object.fromEntries([...b.last.body.matchAll(/type="hidden" name="(type|id|c)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  return b.post("/report", { ...hiddenFields, ...form });
}

test("photo screening: explicit photos are refused and kept in the store; borderline ones are held", async () => {
  const refused = await share(sam, { caption: "nope", color: "#ff0000" });
  assert.equal(refused.status, 400);
  assert.match(refused.body, /can&#39;t be shared on Radius/);
  const [kept] = await app.store.moderatedItems();
  assert.equal(kept.decision, "refused");
  assert.equal(kept.source, "upload");
  assert.equal(kept.labels[0].name, "Explicit Nudity");
  assert.ok(fs.existsSync(path.join(app.mediaDir, kept.media_keys[0])));

  const held = await share(sam, { caption: "held for review", color: "#0000ff" });
  const id = postId(held);
  await sam.get(`/p/${id}`);
  assert.match(sam.last.body, /Only you can see this while it.s being reviewed/);
  await alex.get(`/p/${id}`);
  assert.equal(alex.last.status, 404);
  await alex.get("/?tab=nearby");
  assert.doesNotMatch(alex.last.body, /held for review/);

  // The owner sees it in the queue (with the labels) and keeps it up.
  await adminGet("/admin/moderation");
  assert.match(admin.last.body, /held for review/);
  assert.match(admin.last.body, /Graphic Violence 88%/);
  await adminPost(`/admin/moderation/post/${id}/keep`);
  await alex.get(`/p/${id}`);
  assert.equal(alex.last.status, 200);
});

test("screening also covers profile photos and snaps", async () => {
  await sam.get("/settings");
  const up = multipart("photo", "me.jpg", await phonePhoto({ color: "#ff0000" }));
  const res = await sam.request(`/settings/photo?_token=${sam.token()}`, { body: up.body, headers: up.headers });
  assert.equal(res.status, 400);
  assert.match(res.body, /can&#39;t be used as a profile photo/);
  assert.equal((await app.store.userByUsername("sam")).photo_key, null);
});

test("reporting a post: private, three reports hide it, the owner removes it into the store", async () => {
  const id = postId(await share(alex, { caption: "spammy post" }));
  for (const [b, reason] of [
    [sam, "spam"],
    [jo, "spam"],
  ]) {
    const res = await report(b, `type=post&id=${id}`, { reason, details: "buy followers" });
    assert.equal(res.status, 200);
    assert.match(res.body, /Thanks for telling us/);
  }
  // Two reports: still up. Reporting twice doesn't count twice.
  await report(sam, `type=post&id=${id}`, { reason: "spam" });
  assert.equal((await app.store.post(id, 0)).status, "visible");
  const casey = await join(app, "casey@example.com", "casey");
  await report(casey, `type=post&id=${id}`, { reason: "harassment" });
  await sam.get(`/p/${id}`);
  assert.equal(sam.last.status, 404, "hidden after three people reported it");

  await adminGet("/admin");
  assert.match(admin.last.body, /3 open reports/);
  await adminGet("/admin/moderation");
  assert.match(admin.last.body, /spammy post/);
  assert.match(admin.last.body, /Hidden, waiting for you/);
  await adminPost(`/admin/moderation/post/${id}/remove`, { note: "spam ring" });
  const post = await app.store.postForModeration(id);
  assert.equal(post.status, "removed");
  assert.equal(fs.existsSync(path.join(app.mediaDir, post.photo_keys[0])), false, "live photo deleted");
  const [item] = await app.store.moderatedItems({ decision: "removed" });
  assert.equal(item.body, "spammy post");
  assert.deepEqual(item.report_reasons.sort(), ["harassment", "spam"]);
  assert.equal(item.note, "spam ring");
  assert.ok(fs.existsSync(path.join(app.mediaDir, item.media_keys[0])), "copy kept in the store");
  await adminGet("/admin/removed");
  assert.match(admin.last.body, /spammy post/);
  // The store's photos are only for the admin.
  assert.equal((await sam.get(`/${item.media_keys[0]}`)).status, 404);
  assert.equal((await admin.request(`/admin/media/${item.media_keys[0]}`, as)).status, 200);
  await adminGet("/admin/moderation");
  assert.doesNotMatch(admin.last.body, /spammy post/);
});

test("a report about a minor hides the post at once, and legal hold locks it away and bans", async () => {
  const id = postId(await share(jo, { caption: "worrying" }));
  await report(sam, `type=post&id=${id}`, { reason: "minor" });
  await alex.get(`/p/${id}`);
  assert.equal(alex.last.status, 404);
  const alert = app.emails.find((e) => /URGENT/.test(e.subject));
  assert.ok(alert, "the owner is emailed straight away");
  assert.equal(alert.to, OWNER);

  await adminGet("/admin/moderation");
  assert.match(admin.last.body, /mod urgent/);
  await adminPost(`/admin/moderation/post/${id}/legal-hold`);
  assert.match(admin.last.location, /done=legalHold/);
  const [item] = await app.store.moderatedItems({ decision: "legal_hold" });
  assert.equal(item.training_ok, false);
  assert.equal((await app.store.userByUsername("jojo")).status, "banned");
  // Never shown, even to the admin.
  assert.equal((await admin.request(`/admin/media/${item.media_keys[0]}`, as)).status, 404);
  await adminGet("/admin/removed?show=legal_hold");
  assert.match(admin.last.body, /Locked away/);
  assert.doesNotMatch(admin.last.body, new RegExp(item.media_keys[0]));
  await app.store.unban((await app.store.userByUsername("jojo")).id);
});

test("blocking: no profile, posts, comments or messages either way; unblock from Settings", async () => {
  const id = postId(await share(alex, { caption: "alex's sunset" }));
  await sam.get(`/p/${id}`);
  await sam.post(`/p/${id}/comments`, { body: "sam was here" });
  await alex.get("/@sam");
  await alex.post("/@sam/follow");
  await alex.get("/@sam");
  await alex.post("/@sam/block");
  await alex.get("/@sam");
  assert.match(alex.last.body, /blocked this account/);
  assert.equal((await app.store.followStats((await app.store.userByUsername("sam")).id, 0)).followers, 0, "following ends");

  // Sam can't find alex at all.
  assert.equal((await sam.get("/@alex")).status, 404);
  assert.equal((await sam.get(`/p/${id}`)).status, 404);
  await sam.get("/");
  await sam.post("/feed/location", { lat: "37.2087", lon: "-93.2923" });
  await sam.get("/?tab=nearby");
  assert.doesNotMatch(sam.last.body, /alex&#39;s sunset/);
  // Alex doesn't see sam's comment.
  await alex.get(`/p/${id}`);
  assert.doesNotMatch(alex.last.body, /sam was here/);
  // No messages.
  await sam.get("/settings");
  const msg = await sam.post("/@alex/message");
  assert.equal(msg.status, 404);

  await alex.get("/settings");
  assert.match(alex.last.body, /@sam/);
  await alex.post("/@sam/unblock", { back: "/settings" });
  assert.equal(alex.last.location, "/settings#blocked");
  assert.equal((await sam.get("/@alex")).status, 200);
});

test("reporting a message keeps a copy; a snap can be reported for an hour after it's opened", async () => {
  await alex.get("/@sam");
  await alex.post("/@sam/follow"); // so sam can message alex straight away
  await sam.get("/@alex");
  await sam.post("/@alex/message");
  const chat = sam.last.location;
  await sam.get(chat);
  await sam.post(chat, { body: "a nasty message" });
  await alex.get(chat);
  await alex.post(`${chat}/accept`);
  const {
    rows: [m],
  } = await app.pool.query("select id from messages where body = 'a nasty message'");
  await alex.get(chat);
  assert.match(alex.last.body, new RegExp(`/report\\?type=message&amp;c=\\d+&amp;id=${m.id}`));
  await report(alex, `type=message&c=${chat.split("/").pop()}&id=${m.id}`, { reason: "harassment", block: "on" });
  const [r] = (await app.store.openReports()).filter((x) => x.target_type === "message");
  assert.equal(r.snapshot_text, "a nasty message");
  assert.equal(await app.store.blockBetween((await app.store.userByUsername("alex")).id, (await app.store.userByUsername("sam")).id), "me");
  await alex.get("/@sam");
  await alex.post("/@sam/unblock");

  // A snap: open it, then report it.
  await sam.get(chat);
  const up = multipart("photo", "s.jpg", await phonePhoto());
  await sam.request(`${chat}/snap?_token=${sam.token()}`, { body: up.body, headers: up.headers });
  const {
    rows: [snap],
  } = await app.pool.query("select id from messages where kind = 'snap' order by id desc limit 1");
  await alex.get(chat);
  const view = await alex.post(`${chat}/snaps/${snap.id}`);
  assert.match(view.body, /Report this snap/);
  await report(alex, `type=message&c=${chat.split("/").pop()}&id=${snap.id}`, { reason: "nudity" });
  const snapReport = (await app.store.openReports()).find((x) => x.message_id === snap.id);
  assert.match(snapReport.snapshot_key, /^moderated\//);
  assert.ok(fs.existsSync(path.join(app.mediaDir, snapReport.snapshot_key)));

  // The owner removes it: into the store as a snap.
  await adminGet("/admin/moderation");
  await adminPost(`/admin/moderation/report/${snapReport.id}/remove`);
  const [item] = await app.store.moderatedItems({ decision: "removed" });
  assert.equal(item.source, "snap");
  assert.deepEqual(item.media_keys, [snapReport.snapshot_key]);
});

test("reporting a person, and you can't report yourself", async () => {
  await sam.get("/report?type=user&id=sam");
  assert.equal(sam.last.status, 404);
  await report(sam, "type=user&id=casey", { reason: "impersonation" });
  await adminGet("/admin/moderation");
  assert.match(admin.last.body, /Account @casey/);
  const r = (await app.store.openReports()).find((x) => x.target_type === "user");
  await adminPost(`/admin/moderation/report/${r.id}/dismiss`);
  assert.equal((await app.store.report1(r.id)).status, "resolved");
});
