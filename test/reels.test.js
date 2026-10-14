const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { startApp, join, phonePhoto, multipartMany } = require("./helpers");
const { ffmpeg, withTemp, isVideo } = require("../lib/video");
const { makeBeat } = require("../lib/beats");

let app;
let sam;
let alex;
let jo;
const SPRINGFIELD = { lat: "37.2087", lon: "-93.2923" };

/** A short phone-like clip (with sound, which should be dropped). */
const clipOf = (color, seconds = 3) =>
  withTemp(async (dir) => {
    const out = path.join(dir, "clip.mp4");
    const source = color ? `color=c=${color}:s=360x640:d=${seconds}:r=30` : `testsrc=duration=${seconds}:size=360x640:rate=30`;
    await ffmpeg(["-f", "lavfi", "-i", source, "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out]);
    return fs.promises.readFile(out);
  });

test.before(async () => {
  app = await startApp();
  sam = await join(app, "sam@example.com", "sam", { display_name: "Sam Rivers" });
  alex = await join(app, "alex@example.com", "alex", { display_name: "Alex Stone" });
  jo = await join(app, "jo@example.com", "jojo", { display_name: "Jo March" });
  for (const b of [sam, alex, jo]) {
    await b.get("/");
    await b.post("/feed/location", SPRINGFIELD);
  }
});
test.after(() => app.stop());

async function share(b, caption, files) {
  await b.get("/new");
  const up = multipartMany({ caption, with_location: "on", ...SPRINGFIELD }, "photos", files);
  return b.request(`/new?_token=${b.token()}`, { body: up.body, headers: up.headers });
}
const audioStreams = (log) => (log.split("Output #0")[0].match(/Stream #\d+:\d+.*Audio/g) || []).length;
const probe = (buffer) =>
  withTemp(async (dir) => {
    await fs.promises.writeFile(path.join(dir, "v.mp4"), buffer);
    return ffmpeg(["-i", path.join(dir, "v.mp4"), "-f", "null", "-"]);
  });

test("video clips: silent, small, screened frame by frame, played in the feed", async () => {
  await sam.get("/new");
  assert.match(sam.last.body, /Add photos or clips/);
  assert.match(sam.last.body, /accept="image\/\*,video\/\*"/);
  const res = await share(sam, "Skate park session", [await clipOf(null)]);
  assert.match(res.location, /^\/p\/\d+$/);
  await sam.get(res.location);
  const video = sam.last.body.match(/<video src="\/(media\/[0-9a-f]{32}\.mp4)" poster="\/media\/[0-9a-f]{32}\.webp"/);
  assert.ok(video, "the post plays the clip");
  const stored = fs.readFileSync(path.join(app.mediaDir, video[1]));
  assert.ok(isVideo(stored));
  assert.equal(audioStreams(await probe(stored)), 0, "the sound is gone");

  // Phones fetch video in pieces.
  const part = await sam.request(`/${video[1]}`, { headers: { range: "bytes=0-99" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 0-99/${stored.length}`);
  assert.equal(part.body.length, 100);
  assert.equal((await sam.get(`/${video[1]}`)).headers.get("content-type"), "video/mp4");

  // Every second is screened: a "nude" clip is refused.
  const bad = await share(alex, "nope", [await clipOf("red", 2)]);
  assert.equal(bad.status, 400);
  assert.match(bad.body, /can&#39;t be shared|can't be shared/);

  // Deleting the post deletes the clip.
  const id = res.location.split("/").pop();
  await sam.get(`/p/${id}`);
  await sam.post(`/p/${id}/delete`);
  assert.equal(fs.existsSync(path.join(app.mediaDir, video[1])), false);

  // Off for this person: photos only.
  await app.store.setFeatures({ feature_reels: "off" });
  const off = await share(jo, "clip", [await clipOf(null, 1)]);
  assert.equal(off.status, 400);
  assert.match(off.body, /Video clips aren&#39;t available yet|Video clips aren't available yet/);
  await app.store.setFeatures({ feature_reels: "adults" });
});

test("the beat is made here: a real WAV of the right length", () => {
  const wav = makeBeat({ seconds: 2, style: "night", seed: 3 });
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt32LE(24), 44100);
  assert.equal(wav.length, 44 + Math.ceil(2 * 44100) * 4);
  assert.deepEqual(makeBeat({ seconds: 1, seed: 5 }), makeBeat({ seconds: 1, seed: 5 }), "the same Moment always sounds the same");
});

test("Moment Reels: made on request, then for everyone in it when the Moment ends", async () => {
  await share(sam, "Farmers market", [await phonePhoto({ color: "#f6a35c" })]);
  await share(alex, "Market haul", [await phonePhoto({ color: "#6b5bd6" }), await clipOf(null, 2)]);
  await share(jo, "Best tacos", [await phonePhoto({ color: "#9fd3a8" })]);
  const moment = (await app.pool.query("select * from moments order by id desc limit 1")).rows[0];
  assert.ok(moment, "three people posting from one spot made a Moment");

  await sam.get(`/m/${moment.id}`);
  assert.match(sam.last.body, /Make the Moment Reel/);
  await sam.post(`/m/${moment.id}/reel`);
  assert.equal(sam.last.location, `/m/${moment.id}#reel`);
  let status = "rendering";
  for (let i = 0; i < 120 && status === "rendering"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    status = JSON.parse((await sam.get(`/m/${moment.id}/reel.json`)).body).status;
  }
  assert.equal(status, "ready");
  await sam.get(`/m/${moment.id}`);
  const key = sam.last.body.match(/<video src="\/(media\/[0-9a-f]{32}\.mp4)" poster=/)[1];
  assert.match(sam.last.body, /data-share-video=/);
  const log = await probe(fs.readFileSync(path.join(app.mediaDir, key)));
  assert.equal(audioStreams(log), 1, "set to a beat");
  assert.match(log, /720x1280/);

  // When the Moment has ended, everyone who posted hears their reel is ready (made once, sent once).
  await app.pool.query("update moments set last_post_at = now() - interval '1 hour' where id = $1", [moment.id]);
  await app.runReels();
  for (const b of [sam, alex, jo]) assert.match((await b.get("/activity")).body, /Your Moment Reel is ready/);
  await app.runReels();
  const notes = await app.pool.query("select count(*)::int as n from notifications where kind = 'reel'");
  assert.equal(notes.rows[0].n, 3);
  const reels = await app.pool.query("select count(*)::int as n from reels where moment_id = $1", [moment.id]);
  assert.equal(reels.rows[0].n, 1);
});
