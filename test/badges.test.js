const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, join, phonePhoto, multipartMany } = require("./helpers");

let app;
let sam;
const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
test.before(async () => {
  app = await startApp();
  sam = await join(app, "sam@example.com", "sam");
});
test.after(() => app.stop());

async function share(caption, where = SPRINGFIELD) {
  await sam.get("/new");
  const up = multipartMany({ caption, with_location: "on", ...where }, "photos", [await phonePhoto()]);
  const res = await sam.request(`/new?_token=${sam.token()}`, { body: up.body, headers: up.headers });
  return res.location.split("/").pop();
}

test("founding members get a badge, with a note in Activity", async () => {
  await sam.get("/@sam");
  assert.match(sam.last.body, /🌱 Founding member/);
  await sam.get("/activity");
  assert.match(sam.last.body, /You earned a badge: 🌱 Founding member/);
});

test("Local: five \"Taken here\" photos; the badges page shows what's left", async () => {
  for (let i = 0; i < 5; i++) {
    const id = await share(`walk ${i}`);
    await app.pool.query("update posts set taken_here = true where id = $1", [id]);
  }
  await share("one more");
  await sam.get("/@sam");
  assert.match(sam.last.body, /📍 Local/);
  await sam.get("/badges");
  assert.match(sam.last.body, /2 of 10 earned/);
  assert.match(sam.last.body, /class="earned"[^>]*>.*Local/s);
  assert.match(sam.last.body, /Explorer/);
});

test("Explorer: posts from five towns; badges are only earned once", async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await share(`town ${i}`));
  for (const [i, id] of ids.entries()) await app.pool.query("update posts set area_name = $2 where id = $1", [id, `Town ${i}, MO`]);
  await share("trigger");
  await share("again");
  const { rows } = await app.pool.query("select count(*)::int as n from notifications where kind = 'badge' and detail = 'explorer'");
  assert.equal(rows[0].n, 1);
  // Someone else's profile shows their badges too.
  const other = await join(app, "other@example.com", "other");
  await other.get("/@sam");
  assert.match(other.last.body, /🧭 Explorer/);
});
