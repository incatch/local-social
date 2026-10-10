const test = require("node:test");
const assert = require("node:assert/strict");
const { startApp, join, phonePhoto, multipartMany, OWNER } = require("./helpers");

let app;
let admin;
let adult;
test.before(async () => {
  app = await startApp();
  admin = app.browser();
  adult = await join(app, "adult@example.com", "grownup");
});
test.after(() => app.stop());

const as = { headers: { "x-test-admin": OWNER } };
/** A birthday for someone `age` years old (a month past their birthday). */
function dob(age) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - age);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}
const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
const TORONTO = { lat: "43.70", lon: "-79.40" };

async function teenSettings(form) {
  await admin.request("/admin/teens", as);
  return admin.request("/admin/teens", { ...as, form: { _token: admin.token(), ...form } });
}
async function share(b, caption, where = SPRINGFIELD) {
  await b.get("/new");
  const up = multipartMany({ caption, with_location: "on", ...where }, "photos", [await phonePhoto()]);
  const res = await b.request(`/new?_token=${b.token()}`, { body: up.body, headers: up.headers });
  return res.location.split("/").pop();
}
async function follow(b, username) {
  await b.get(`/@${username}`);
  await b.post(`/@${username}/follow`);
}

test("teen mode is off by default: under-18s can't join", async () => {
  const b = await join(app, "kid@example.com", "kiddo", { birth_date: dob(16) });
  assert.equal(b.last.status, 400);
  assert.match(b.last.body, /18 or older to use Radius for now/);
});

test("the owner turns it on in Admin → Teen mode; the rules are settings", async () => {
  await admin.request("/admin/teens", as);
  assert.match(admin.last.body, /Let under-18s join/);
  await teenSettings({ teens_enabled: "on", teen_min_age: "13", teen_states: "mo", parental_consent_under: "16", teen_messages: "mutual", teen_photos: "mutual", teen_strict_screening: "on", teen_min_radius: "10" });
  await app.store.setInviteOnly(false); // so the retries below don't need the invite code again
  const s = await app.store.settings();
  assert.equal(s.teens_enabled, true);
  assert.deepEqual(s.teen_states, ["MO"]);
  assert.equal(s.parental_consent_under, 16);
  assert.equal(s.teen_show_distance, false, "an unticked box is off");
  // The terms now describe it.
  const terms = await app.browser().get("/terms");
  assert.match(terms.body, /You must be 13 or older \(under-18s only in MO\)/);
  assert.match(terms.body, /teens-only part/);
});

test("joining as a teen: 13+, in an allowed state, and a parent's OK when younger", async () => {
  const young = await join(app, "twelve@example.com", "twelve", { birth_date: dob(12) });
  assert.match(young.last.body, /13 or older to use Radius/);

  const noPlace = await join(app, "fifteen@example.com", "fifteen", { birth_date: dob(15) });
  assert.match(noPlace.last.body, /share your location/);
  await noPlace.post("/welcome", { birth_date: dob(15), username: "fifteen", display_name: "Fifteen", terms: "on", ...TORONTO });
  assert.match(noPlace.last.body, /isn&#39;t open to under-18s where you are/);
  await noPlace.post("/welcome", { birth_date: dob(15), username: "fifteen", display_name: "Fifteen", terms: "on", ...SPRINGFIELD });
  assert.match(noPlace.last.body, /parent&#39;s email/);
  await noPlace.post("/welcome", { birth_date: dob(15), username: "fifteen", display_name: "Fifteen", terms: "on", parent_email: "mom@example.com", ...SPRINGFIELD });
  assert.equal(noPlace.last.location, "/hello");

  // Waiting for the parent: nothing else works.
  await noPlace.get("/");
  assert.match(noPlace.last.body, /Almost there/);
  assert.match(noPlace.last.body, /mom@example.com/);
  assert.match((await noPlace.get("/@grownup")).body, /Almost there/);
  const user = await app.store.userByUsername("fifteen");
  assert.equal(user.area_name, "Springfield, MO", "their town is filled in from the location");
  assert.ok(user.teen_until > new Date().toISOString().slice(0, 10));
  assert.equal(user.adult_confirmed_at, null);

  // The parent's email, and their yes.
  const email = app.emails.find((e) => e.to === "mom@example.com");
  assert.match(email.subject, /would like to join Radius/);
  const link = email.text.match(/\/consent\/([A-Za-z0-9_-]+)/)[0];
  const parent = app.browser();
  await parent.get(link);
  assert.match(parent.last.body, /adults can.t find them/);
  await parent.request(link, { form: { answer: "yes" } });
  assert.match(parent.last.body, /can now use Radius/);
  assert.equal((await parent.get(link)).status, 404, "the link works once");
  await noPlace.get("/");
  assert.doesNotMatch(noPlace.last.body, /Almost there/);
});

test("a parent can say no, which deletes the account", async () => {
  const b = await join(app, "fourteen@example.com", "fourteen", { birth_date: dob(14), parent_email: "dad@example.com", ...SPRINGFIELD });
  assert.equal(b.last.location, "/hello");
  const link = app.emails.find((e) => e.to === "dad@example.com").text.match(/\/consent\/([A-Za-z0-9_-]+)/)[0];
  await app.browser().request(link, { form: { answer: "no" } });
  assert.equal(await app.store.userByUsername("fourteen"), null);
});

test("teens and adults live in separate worlds", async () => {
  const teen = await join(app, "seventeen@example.com", "seventeen", { birth_date: dob(17), ...SPRINGFIELD });
  assert.equal(teen.last.location, "/hello", "17: no parent needed (under 16 only)");
  const teenPost = await share(teen, "teen sunset");
  const adultPost = await share(adult, "adult sunset");
  for (const b of [teen, adult]) {
    await b.get("/");
    await b.post("/feed/location", SPRINGFIELD);
  }
  // Profiles and posts across the line don't exist.
  assert.equal((await adult.get("/@seventeen")).status, 404);
  assert.equal((await teen.get("/@grownup")).status, 404);
  assert.equal((await adult.get(`/p/${teenPost}`)).status, 404);
  assert.equal((await teen.get(`/p/${adultPost}`)).status, 404);
  await adult.get("/?tab=nearby");
  assert.match(adult.last.body, /adult sunset/);
  assert.doesNotMatch(adult.last.body, /teen sunset/);
  await teen.get("/?tab=nearby");
  assert.match(teen.last.body, /teen sunset/);
  assert.doesNotMatch(teen.last.body, /adult sunset/);
  // Teens see the town but not the distance, and can't pick under 10 miles.
  assert.match(teen.last.body, /Springfield, MO</);
  assert.doesNotMatch(teen.last.body, /within 2 mi|· \d+ mi/);
  assert.doesNotMatch(teen.last.body, /value="5"/);
  const small = await teen.post("/feed/radius", { miles: "5" });
  assert.equal(small.status, 400);
  // No messages across the line either.
  await adult.get("/settings");
  assert.equal((await adult.post("/@seventeen/message")).status, 404);
  assert.equal(await app.store.canInteract((await app.store.userByUsername("grownup")).id, (await app.store.userByUsername("seventeen")).id), false);
});

test("teens message mutual follows, and photos follow the setting", async () => {
  const teen = app.browser();
  const { signIn } = require("./helpers");
  await signIn(app, teen, "seventeen@example.com");
  const other = await join(app, "sixteen@example.com", "sixteen", { birth_date: dob(16), ...SPRINGFIELD });
  await teen.get("/@sixteen");
  const no = await teen.post("/@sixteen/message");
  assert.equal(no.status, 400);
  assert.match(no.body, /follow you back/);
  await follow(teen, "sixteen");
  await follow(other, "seventeen");
  await teen.get("/@sixteen");
  await teen.post("/@sixteen/message");
  assert.match(teen.last.location, /^\/messages\/\d+$/);
  await teen.get(teen.last.location);
  assert.match(teen.last.body, /Send a photo/, "mutual follows can send photos");

  // Photos off for teens: the button goes.
  await teenSettings({ teens_enabled: "on", teen_states: "MO", parental_consent_under: "16", teen_messages: "mutual", teen_photos: "off", teen_strict_screening: "on", teen_min_radius: "10" });
  await teen.get(teen.last.location ? teen.last.location : "/messages");
  const chat = (await app.pool.query("select id from conversations order by id desc limit 1")).rows[0].id;
  await teen.get(`/messages/${chat}`);
  assert.doesNotMatch(teen.last.body, /Send a photo/);
});

test("turning 18 moves someone to the adult world automatically", async () => {
  const id = (await app.store.userByUsername("seventeen")).id;
  await app.pool.query("update users set teen_until = current_date where id = $1", [id]);
  assert.equal(await app.store.canInteract((await app.store.userByUsername("grownup")).id, id), true);
  assert.equal((await adult.get("/@seventeen")).status, 200);
});
