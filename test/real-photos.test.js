const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { startApp, join, OWNER } = require("./helpers");
const { aiMarker, checkPhoto } = require("../lib/provenance");

let app;
let poster;
let neighbor;
let admin;
const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };
const as = { headers: { "x-test-admin": OWNER } };

test.before(async () => {
  app = await startApp();
  poster = await join(app, "poster@example.com", "poster");
  neighbor = await join(app, "neighbor@example.com", "neighbor");
  admin = app.browser();
  await neighbor.get("/");
  await neighbor.post("/feed/location", SPRINGFIELD);
});
test.after(() => app.stop());

const exifTime = (d) => d.toISOString().slice(0, 19).replace("T", " ").replace(/-/g, ":");
/** A JPEG as a phone or an AI tool would save it. */
function photo({ ai = false, takenAt = null, gps = true } = {}) {
  let img = sharp({ create: { width: 1200, height: 900, channels: 3, background: "#4a7" } });
  if (takenAt) {
    img = img.withExif({
      IFD2: { DateTimeOriginal: exifTime(takenAt), OffsetTimeOriginal: "+00:00" },
      ...(gps ? { IFD3: { GPSLatitudeRef: "N", GPSLatitude: "37/1 12/1 31/1", GPSLongitudeRef: "W", GPSLongitude: "93/1 17/1 32/1" } } : {}),
    });
  }
  if (ai) {
    img = img.withXmp(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/></rdf:RDF></x:xmpmeta>',
    );
  }
  return img.jpeg().toBuffer();
}
function form(fields, files) {
  const boundary = "----t" + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const [name, buf] of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), buf, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
async function share(caption, files) {
  await poster.get("/new");
  const up = form({ caption, with_location: "on", ...SPRINGFIELD }, files);
  const res = await poster.request(`/new?_token=${poster.token()}`, { body: up.body, headers: up.headers });
  return res.location.split("/").pop();
}
const nearby = async () => (await neighbor.get("/?tab=nearby")).body;

test("reading the photo's own labels", async () => {
  assert.equal(aiMarker(await photo({ ai: true })), "trainedAlgorithmicMedia");
  assert.equal(aiMarker(await photo()), null);
  assert.equal(aiMarker(Buffer.from("tEXtparameters\0a cat\nSteps: 20, Sampler: Euler a, CFG scale: 7")), "image generator settings");
  const place = { lat: 37.2087, lon: -93.2923 };
  assert.equal((await checkPhoto(await photo({ takenAt: new Date() }), { place })).takenHere, true);
  assert.equal((await checkPhoto(await photo({ takenAt: new Date(Date.now() - 3 * 86400000) }), { place })).takenHere, false, "too old");
  assert.equal((await checkPhoto(await photo({ takenAt: new Date() }), { place: { lat: 39.1, lon: -94.58 } })).takenHere, false, "too far");
  assert.equal((await checkPhoto(await photo({ takenAt: new Date(), gps: false }), { place })).takenHere, false, "no camera location");
});

test("AI-made photos stay off Nearby; followers still see them; the poster is told", async () => {
  const real = await share("Real sunset", [["photos", await photo({ takenAt: new Date() })]]);
  const fake = await share("Me in Santorini", [["photos", await photo({ ai: true })]]);
  const feed = await nearby();
  assert.match(feed, /Real sunset/);
  assert.doesNotMatch(feed, /Santorini/);
  const post = await app.store.postForModeration(fake);
  assert.equal(post.ai_made, true);
  assert.match(post.ai_reason, /made with AI \(trainedAlgorithmicMedia\)/);
  await poster.get(`/p/${fake}`);
  assert.match(poster.last.body, /Nearby is for photos taken around here/);
  await neighbor.get("/@poster");
  await neighbor.post("/@poster/follow");
  assert.match((await neighbor.get("/?tab=following")).body, /Santorini/);
  // The real one has the badge; the fake doesn't.
  await neighbor.get(`/p/${real}`);
  assert.match(neighbor.last.body, /Taken here/);
  await neighbor.get(`/p/${fake}`);
  assert.doesNotMatch(neighbor.last.body, /class="taken"/);
});

test("the website's way: a shrunk photo plus the start of the original", async () => {
  const plain = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#4a7" } }).jpeg().toBuffer();
  const viaHead = await share("Shrunk but labelled", [["photos", plain], ["head0", (await photo({ ai: true })).subarray(0, 4096)]]);
  assert.equal((await app.store.postForModeration(viaHead)).ai_made, true);
  const fresh = await share("Shrunk and fresh", [["photos", plain], ["head0", await photo({ takenAt: new Date() })]]);
  assert.equal((await app.store.postForModeration(fresh)).taken_here, true);
  // No camera record at all: no badge (but still on Nearby).
  const bare = await share("Screenshot", [["photos", plain]]);
  assert.equal((await app.store.postForModeration(bare)).taken_here, false);
  assert.match(await nearby(), /Screenshot/);
});

test("reports of fake photos: the owner can keep it up but off Nearby; settings switch it all off", async () => {
  const id = await share("Totally real yacht", [["photos", await photo()]]);
  assert.match(await nearby(), /Totally real yacht/);
  await neighbor.get(`/report?type=post&id=${id}`);
  await neighbor.post("/report", { type: "post", id, reason: "fake_ai" });
  await admin.request("/admin/moderation", as);
  assert.match(admin.last.body, /Fake or AI-made photo/);
  await admin.request(`/admin/moderation/post/${id}/off-nearby`, { ...as, form: { _token: admin.token() } });
  assert.doesNotMatch(await nearby(), /Totally real yacht/);
  assert.match((await neighbor.get("/?tab=following")).body, /Totally real yacht/);

  // Admin → Nearby rules lists it, and can show it anyway.
  await admin.request("/admin/nearby", as);
  assert.match(admin.last.body, /Kept off Nearby by the owner/);
  // Turning the AI rule off brings AI posts back to Nearby; the badge can be turned off too.
  await admin.request("/admin/nearby", { ...as, form: { _token: admin.token(), nearby_politics_filter: "on", taken_here_hours: "24", taken_here_miles: "5" } });
  const s = await app.store.settings();
  assert.equal(s.nearby_ai_filter, false);
  assert.equal(s.taken_here_badge, false);
  assert.match(await nearby(), /Santorini/);
  const later = await share("Fresh but no badge now", [["photos", await photo({ takenAt: new Date() })]]);
  assert.equal((await app.store.postForModeration(later)).taken_here, false);
});
