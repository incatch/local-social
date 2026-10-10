const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { startApp, join, phonePhoto, multipart } = require("./helpers");

let app;
let sam;
let alex;
let jo;
test.before(async () => {
  app = await startApp();
  sam = await join(app, "sam@example.com", "sam");
  alex = await join(app, "alex@example.com", "alex");
  jo = await join(app, "jo@example.com", "jojo");
});
test.after(() => app.stop());

const idOf = async (username) => (await app.store.userByUsername(username)).id;

/** Opens (or starts) the chat with `username` from their profile; returns its path. */
async function openChat(b, username) {
  await b.get(`/@${username}`);
  await b.post(`/@${username}/message`);
  assert.match(b.last.location, /^\/messages\/\d+$/);
  const where = b.last.location;
  await b.get(where);
  return where;
}
async function say(b, chat, body) {
  await b.get(chat);
  return b.post(chat, { body });
}
async function sendSnap(b, chat) {
  await b.get(chat);
  const upload = multipart("photo", "snap.jpg", await phonePhoto());
  return b.request(`${chat}/snap?_token=${b.token()}`, { body: upload.body, headers: upload.headers });
}

test("a first message to someone who doesn't follow you is a request", async () => {
  const chat = await openChat(sam, "alex");
  assert.match(sam.last.body, /Message request sent/);
  assert.doesNotMatch(sam.last.body, /Send a snap/, "no snaps until accepted");
  await say(sam, chat, "hi alex!");
  await say(sam, chat, "it's sam");
  await say(sam, chat, "from the coffee shop");
  const res = await say(sam, chat, "one more");
  assert.equal(res.status, 400);
  assert.match(res.body, /up to 3 messages until they accept/);

  // Alex sees it under Requests, not the inbox, with a badge.
  await alex.get("/messages");
  assert.match(alex.last.body, /Message requests \(1\)/);
  assert.doesNotMatch(alex.last.body, /hi alex/);
  assert.match(alex.last.body, /<b class="count">1<\/b>/);
  await alex.get("/messages/requests");
  assert.match(alex.last.body, /sam/);

  // Looking at a request doesn't tell sam it was seen.
  await alex.get(chat);
  assert.match(alex.last.body, /wants to message you/);
  assert.match(alex.last.body, /from the coffee shop/);
  const { rows } = await app.pool.query("select count(*)::int as n from messages where read_at is not null");
  assert.equal(rows[0].n, 0);

  // Accepting moves it to the inbox and marks it read.
  await alex.post(`${chat}/accept`);
  await alex.get(chat);
  assert.doesNotMatch(alex.last.body, /wants to message you/);
  await sam.get(chat);
  assert.match(sam.last.body, /Seen/);
  assert.match(sam.last.body, /Send a snap/);
  const ok = await say(sam, chat, "great!");
  assert.equal(ok.status, 303);
});

test("people you follow can message you straight away; replying accepts a request", async () => {
  await jo.get("/@sam");
  await jo.post("/@sam/follow");
  const chat = await openChat(sam, "jojo");
  assert.doesNotMatch(sam.last.body, /Message request sent/);
  await say(sam, chat, "hey jo");
  await jo.get("/messages");
  assert.match(jo.last.body, /New message/);
  assert.doesNotMatch(jo.last.body, /Message requests/);

  // Jo messages alex (who doesn't follow jo): alex replies instead of accepting.
  const chat2 = await openChat(jo, "alex");
  await say(jo, chat2, "hi");
  await say(alex, chat2, "hello");
  const c = await app.store.conversation(chat2.split("/").pop(), await idOf("alex"));
  assert.ok(c.accepted_at);
});

test("you can't message yourself, and the chat is private to the two people", async () => {
  await sam.get("/@sam");
  assert.doesNotMatch(sam.last.body, /\/@sam\/message/);
  const chat = await openChat(sam, "alex");
  await jo.get(chat);
  assert.equal(jo.last.status, 404);
  await jo.get("/settings");
  const res = await jo.post(chat, { body: "sneaky" });
  assert.equal(res.status, 404);
});

test("snaps open once, then the photo is deleted", async () => {
  const chat = await openChat(sam, "alex");
  await alex.get(chat); // read what's there already
  const res = await sendSnap(sam, chat);
  assert.equal(res.status, 303);
  const {
    rows: [snap],
  } = await app.pool.query("select * from messages where kind = 'snap' order by id desc limit 1");
  assert.ok(fs.existsSync(path.join(app.mediaDir, snap.photo_key)));
  assert.equal(snap.photo_key.endsWith(".webp"), true);

  // The sender can't open it; it just says it was sent.
  await sam.get(chat);
  assert.match(sam.last.body, /Snap sent/);
  assert.doesNotMatch(sam.last.body, /Tap to view snap/);
  const peek = await sam.post(`${chat}/snaps/${snap.id}`);
  assert.equal(peek.status, 400);

  await alex.get("/messages");
  assert.match(alex.last.body, /New snap/);
  await alex.get(chat);
  assert.match(alex.last.body, /Tap to view snap/);
  const view = await alex.post(`${chat}/snaps/${snap.id}`);
  assert.equal(view.status, 200);
  assert.match(view.body, /<img src="data:image\/webp;base64,/);
  // Kept for an hour so it can be reported, then deleted.
  assert.ok(fs.existsSync(path.join(app.mediaDir, snap.photo_key)));
  for (const key of await app.store.purgeSnapWindows(new Date(Date.now() + 61 * 60 * 1000))) await app.media.remove(key);
  assert.equal(fs.existsSync(path.join(app.mediaDir, snap.photo_key)), false, "deleted after the hour");

  // Opening it again doesn't work.
  await alex.get(chat);
  assert.match(alex.last.body, /📷 Opened/);
  const again = await alex.post(`${chat}/snaps/${snap.id}`);
  assert.equal(again.status, 400);
  assert.match(again.body, /already been opened/);
  await sam.get(chat);
  assert.match(sam.last.body, /📷 Opened/);
});

test("messages disappear 24 hours after they're read, unless both keep the chat", async () => {
  const chat = await openChat(jo, "sam");
  await say(jo, chat, "this will vanish");
  await sam.get(chat); // read now
  const later = new Date(Date.now() + 25 * 60 * 60 * 1000);

  // Only jo keeps it: still disappears.
  await jo.get(chat);
  await jo.post(`${chat}/keep`, { keep: "on" });
  await sam.get(chat);
  assert.match(sam.last.body, /@jojo wants to keep this chat/);
  await app.store.purgeMessages(later);
  await jo.get(chat);
  assert.doesNotMatch(jo.last.body, /this will vanish/);

  // Both keep it: read messages stay.
  await say(jo, chat, "this one stays");
  await sam.get(chat);
  await sam.post(`${chat}/keep`, { keep: "on" });
  await sam.get(chat);
  assert.match(sam.last.body, /You both keep this chat/);
  await app.store.purgeMessages(later);
  await sam.get(chat);
  assert.match(sam.last.body, /this one stays/);

  // Unread messages wait (up to 30 days).
  await sam.post(`${chat}/keep`, { keep: "" });
  await say(jo, chat, "unread for now");
  await app.store.purgeMessages(later);
  const { rows } = await app.pool.query("select body from messages where body = 'unread for now'");
  assert.equal(rows.length, 1);
  await app.store.purgeMessages(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
  const { rows: gone } = await app.pool.query("select body from messages where body = 'unread for now'");
  assert.equal(gone.length, 0);
});

test("unopened snaps are deleted with their photo when their time is up", async () => {
  const chat = await openChat(sam, "jojo");
  await sendSnap(sam, chat);
  const {
    rows: [snap],
  } = await app.pool.query("select * from messages where kind = 'snap' order by id desc limit 1");
  assert.equal(snap.read_at, null);
  const keys = await app.store.purgeMessages(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
  assert.ok(keys.includes(snap.photo_key));
});

test("unsending a message, and deleting a request", async () => {
  const casey = await join(app, "casey@example.com", "casey");
  const chat = await openChat(alex, "casey");
  await say(alex, chat, "oops wrong person");
  const {
    rows: [msg],
  } = await app.pool.query("select id from messages where body = 'oops wrong person'");
  // Only the sender can unsend.
  await casey.get(chat);
  const nope = await casey.post(`${chat}/unsend/${msg.id}`);
  assert.equal(nope.status, 400);
  await alex.get(chat);
  await alex.post(`${chat}/unsend/${msg.id}`);
  await alex.get(chat);
  assert.doesNotMatch(alex.last.body, /oops wrong person/);

  await say(alex, chat, "hello casey");
  await casey.get(chat);
  assert.match(casey.last.body, /wants to message you/);
  await casey.post(`${chat}/delete`);
  assert.equal(casey.last.location, "/messages/requests?done=declined");
  const { rows } = await app.pool.query("select count(*)::int as n from conversations where id = $1", [chat.split("/").pop()]);
  assert.equal(rows[0].n, 0);
});

test("Activity: likes, comments, follows and mentions, with a badge until seen", async () => {
  // Alex posts; sam likes, comments and mentions; jo follows alex.
  await alex.get("/new");
  const upload = multipart("photos", "p.jpg", await phonePhoto());
  await alex.request(`/new?_token=${alex.token()}`, { body: upload.body, headers: upload.headers });
  const postId = alex.last.location.split("/").pop();
  await alex.get("/activity"); // clear anything from earlier tests

  await sam.get(`/p/${postId}`);
  await sam.post(`/p/${postId}/like`);
  await sam.get(`/p/${postId}`);
  await sam.post(`/p/${postId}/comments`, { body: "Love this! @jojo should see it" });
  await jo.get("/@alex");
  await jo.post("/@alex/follow");
  await sam.get(`/p/${postId}`);
  await sam.post(`/p/${postId}/like`); // and unlike: that one goes away

  await alex.get("/");
  assert.match(alex.last.body, /aria-label="Activity"><svg[^>]*>(?:(?!<\/svg>).)*<\/svg><b class="count">2<\/b>/);
  await alex.get("/activity");
  assert.match(alex.last.body, /sam<\/strong><\/a> commented: “Love this!/);
  assert.match(alex.last.body, /jojo<\/strong><\/a> started following you/);
  assert.match(alex.last.body, /Follow back/);
  assert.doesNotMatch(alex.last.body, /liked your post/);
  await alex.get("/");
  assert.doesNotMatch(alex.last.body, /aria-label="Activity"><svg[^>]*>(?:(?!<\/svg>).)*<\/svg><b/);

  // Jo was mentioned in the comment.
  await jo.get("/activity");
  assert.match(jo.last.body, /sam<\/strong><\/a> mentioned you in a comment/);

  // Following back from Activity stays on Activity.
  await alex.get("/activity");
  await alex.post("/@jojo/follow", { back: "/activity" });
  assert.equal(alex.last.location, "/activity");
});

test("the app icon and home-screen manifest are served", async () => {
  const b = app.browser();
  for (const p of ["/static/icon.svg", "/static/icon-180.png", "/static/icon-512.png", "/static/manifest.json"]) {
    const res = await b.get(p);
    assert.equal(res.status, 200, p);
  }
  const manifest = JSON.parse((await b.get("/static/manifest.json")).body.toString());
  assert.equal(manifest.name, "Radius");
});
