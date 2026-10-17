// Moment Reels: a ~20-second vertical video of a Moment, cut to a Radius
// beat. A title card, each photo (slowly zooming) or clip, then a
// "made with Radius" end card. 720×1280 so a small server can make it.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { ffmpeg, withTemp } = require("./video");
const { makeBeat, styleFor, STYLES } = require("./beats");

const W = 720;
const H = 1280;
const FPS = 30;
const MAX_ITEMS = 9;
const CARD_SECONDS = 1.6;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Wraps a title onto lines of about `width` characters. */
function lines(text, width = 16) {
  const out = [];
  for (const word of String(text).split(/\s+/)) {
    const last = out[out.length - 1];
    if (last && (last + " " + word).length <= width) out[out.length - 1] = `${last} ${word}`;
    else out.push(word);
  }
  return out.slice(0, 4);
}

async function titleCard(background, { title, subtitle }) {
  const bg = await sharp(background).resize(W, H, { fit: "cover" }).blur(18).modulate({ brightness: 0.55 }).toBuffer();
  const rows = lines(title);
  const top = H / 2 - rows.length * 42;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <g fill="none" stroke="#fff" stroke-width="5" opacity="0.9"><circle cx="${W / 2}" cy="${top - 120}" r="16" fill="#fff"/><circle cx="${W / 2}" cy="${top - 120}" r="38" opacity="0.7"/><circle cx="${W / 2}" cy="${top - 120}" r="60" opacity="0.4"/></g>
  ${rows.map((r, i) => `<text x="${W / 2}" y="${top + i * 84}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="68" fill="#fff">${esc(r)}</text>`).join("")}
  <text x="${W / 2}" y="${top + rows.length * 84 + 30}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#ffd9a8">${esc(subtitle)}</text>
</svg>`;
  return sharp(bg).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 90 }).toBuffer();
}

async function endCard({ site = "Radius", tagline = "Your world. Happening now.", url = "" }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b5fe0"/><stop offset="1" stop-color="#3a3db0"/></linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <g fill="none" stroke="#fff" stroke-width="6"><circle cx="${W / 2}" cy="520" r="22" fill="#fff"/><circle cx="${W / 2}" cy="520" r="56" opacity="0.75"/><circle cx="${W / 2}" cy="520" r="92" stroke="#f9a53c" opacity="0.9"/></g>
  <text x="${W / 2}" y="730" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="92" fill="#fff">${esc(site)}</text>
  <text x="${W / 2}" y="800" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="36" fill="#dfe0ff">${esc(tagline)}</text>
  <text x="${W / 2}" y="1160" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="28" fill="#c9cbff">made with ${esc(site)}${url ? ` · ${esc(url)}` : ""}</text>
</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

const fades = (d) => `fade=t=in:st=0:d=0.18,fade=t=out:st=${Math.max(0, d - 0.18).toFixed(2)}:d=0.18`;

async function stillSegment(dir, name, jpeg, seconds, { zoom = true } = {}) {
  const img = path.join(dir, `${name}.jpg`);
  // A bit bigger than the frame, so the slow zoom stays sharp.
  await fs.promises.writeFile(img, await sharp(jpeg).rotate().resize(W * 1.5, H * 1.5, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer());
  const frames = Math.round(seconds * FPS);
  const motion = zoom ? `zoompan=z='min(zoom+0.0011,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}` : `scale=${W}:${H},fps=${FPS}`;
  const out = path.join(dir, `${name}.mp4`);
  await ffmpeg(["-loop", "1", "-t", seconds.toFixed(3), "-i", img, "-vf", `${motion},${fades(seconds)},format=yuv420p`, "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-r", String(FPS), "-an", out]);
  return out;
}

async function clipSegment(dir, name, mp4, seconds) {
  const src = path.join(dir, `${name}-in.mp4`);
  await fs.promises.writeFile(src, mp4);
  const out = path.join(dir, `${name}.mp4`);
  await ffmpeg([
    "-i", src, "-t", seconds.toFixed(3),
    "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},tpad=stop_mode=clone:stop_duration=${seconds.toFixed(2)},trim=duration=${seconds.toFixed(3)},${fades(seconds)},format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-r", String(FPS), "-an", out,
  ]);
  return out;
}

/**
 * items: [{ kind: "photo", image } | { kind: "video", video, image }] (image
 * = a still: the photo, or the clip's first frame). Returns { video, poster }.
 */
async function renderReel({ items, title, subtitle, seed = 1, site, tagline, url }) {
  const chosen = items.slice(0, MAX_ITEMS);
  if (!chosen.length) throw new Error("A reel needs at least one photo.");
  const style = styleFor(seed);
  const beat = 60 / STYLES[style].bpm;
  const shot = beat * STYLES[style].perShot;
  return withTemp(async (dir) => {
    const parts = [];
    const poster = await titleCard(chosen[0].image, { title, subtitle });
    parts.push(await stillSegment(dir, "title", poster, CARD_SECONDS, { zoom: false }));
    for (const [i, item] of chosen.entries()) {
      parts.push(item.kind === "video" ? await clipSegment(dir, `s${i}`, item.video, shot * 1.5) : await stillSegment(dir, `s${i}`, item.image, shot));
    }
    parts.push(await stillSegment(dir, "end", await endCard({ site, tagline, url }), CARD_SECONDS + 0.6, { zoom: false }));
    await fs.promises.writeFile(path.join(dir, "list.txt"), parts.map((p) => `file '${p}'`).join("\n"));
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", path.join(dir, "list.txt"), "-c", "copy", path.join(dir, "silent.mp4")]);
    const log = await ffmpeg(["-i", path.join(dir, "silent.mp4"), "-f", "null", "-"]);
    const m = /time=(\d+):(\d+):(\d+\.\d+)/g;
    let seconds = 20;
    for (let x; (x = m.exec(log)); ) seconds = Number(x[1]) * 3600 + Number(x[2]) * 60 + Number(x[3]);
    await fs.promises.writeFile(path.join(dir, "beat.wav"), makeBeat({ seconds: seconds + 0.2, style, seed }));
    await ffmpeg([
      "-i", path.join(dir, "silent.mp4"), "-i", path.join(dir, "beat.wav"),
      "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart",
      path.join(dir, "reel.mp4"),
    ]);
    return { video: await fs.promises.readFile(path.join(dir, "reel.mp4")), poster, seconds, style };
  });
}

module.exports = { renderReel, MAX_ITEMS };
