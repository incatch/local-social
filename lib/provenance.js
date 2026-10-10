// Where a photo came from, read from the original file before it's
// re-encoded (which removes all of this).
//
// - AI-made: AI tools (ChatGPT/DALL·E, Gemini/Imagen, Adobe Firefly, Meta
//   AI, Microsoft Designer and others) label their images, in "content
//   credentials" (C2PA) or IPTC metadata, as "trainedAlgorithmicMedia".
//   Some image generators leave their name or settings in the file instead.
// - Taken here: the camera's own record of when and where the photo was
//   taken. It's only compared with the post's place and time, never kept.
//
// The browser shrinks photos before uploading (which also drops this), so it
// sends the start of each original file too; that's where it all lives.

const exifr = require("exifr");
const { milesBetween } = require("./places");

// Text that only AI tools put in image files.
const AI_MARKERS = [
  "trainedAlgorithmicMedia", // IPTC digital source type, in C2PA manifests and XMP
  "compositeWithTrainedAlgorithmicMedia",
  "Midjourney",
  "DALL-E",
  "DALL·E",
  "Stable Diffusion",
  "NovelAI",
  "Negative prompt:",
  "sd-metadata",
];

/** Which AI marker the file carries, or null. */
function aiMarker(buffer) {
  if (!buffer || !buffer.length) return null;
  const text = buffer.toString("latin1");
  for (const marker of AI_MARKERS) {
    if (text.includes(marker)) return marker;
  }
  // Stable Diffusion UIs write their settings into PNG text.
  if (text.includes("Steps: ") && text.includes("Sampler: ") && text.includes("CFG scale")) return "image generator settings";
  return null;
}

/** When and where the camera says the photo was taken: { takenAt, lat, lon, hasOffset } (any may be null). */
async function cameraRecord(buffer) {
  try {
    const out = await exifr.parse(buffer, { gps: true, tiff: true, exif: true, xmp: false, icc: false, iptc: false, translateValues: true, reviveValues: true, pick: ["DateTimeOriginal", "OffsetTimeOriginal", "latitude", "longitude"] });
    if (!out) return { takenAt: null, lat: null, lon: null, hasOffset: false };
    let takenAt = out.DateTimeOriginal instanceof Date ? out.DateTimeOriginal : null;
    // exifr reads the camera's local time as if it were the server's (UTC);
    // apply the camera's own offset when it gave one.
    const offset = /^([+-])(\d{2}):(\d{2})$/.exec(out.OffsetTimeOriginal || "");
    if (takenAt && offset) {
      const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === "+" ? 1 : -1);
      takenAt = new Date(takenAt.getTime() - minutes * 60000);
    }
    return {
      takenAt,
      hasOffset: Boolean(offset),
      lat: Number.isFinite(out.latitude) ? out.latitude : null,
      lon: Number.isFinite(out.longitude) ? out.longitude : null,
    };
  } catch {
    return { takenAt: null, lat: null, lon: null, hasOffset: false };
  }
}

/**
 * Checks one photo. `original` is the start of the original file (or the
 * whole file). Returns { aiMarker, takenHere } — takenHere when the camera's
 * time is within `hours` of now and its place within `miles` of `place`.
 */
async function checkPhoto(original, { place, hours = 24, miles = 5, now = new Date() }) {
  const marker = aiMarker(original);
  const camera = await cameraRecord(original);
  let takenHere = false;
  if (!marker && place && camera.takenAt && camera.lat !== null) {
    // Without the camera's time zone, allow up to 14 hours either way.
    const slack = camera.hasOffset ? 0 : 14;
    const fresh = Math.abs(now - camera.takenAt) <= (hours + slack) * 3600 * 1000 && camera.takenAt - now <= (slack + 1) * 3600 * 1000;
    const close = milesBetween(place, { lat: camera.lat, lon: camera.lon }) <= miles;
    takenHere = fresh && close;
  }
  return { aiMarker: marker, takenHere };
}

module.exports = { checkPhoto, aiMarker, cameraRecord, AI_MARKERS };
