// Uploaded photos are re-encoded before anything is stored:
//
// - Hidden data is removed. Phone photos usually carry the exact GPS spot
//   they were taken (EXIF), which would give away where someone lives.
//   Re-encoding keeps only the pixels.
// - They're turned the right way up (phones often store them sideways with
//   a "rotate me" note), and shrunk to a sensible size.
// - Anything that isn't really an image is refused.
//
// Output is WebP: small files that every current browser shows.

const sharp = require("sharp");

class ImageError extends Error {}

const SIZES = {
  // Profile photos: a square, cropped to the middle.
  avatar: { width: 512, height: 512, fit: "cover" },
  // Posts and snaps: up to 1600 pixels on the long side.
  photo: { width: 1600, height: 1600, fit: "inside" },
  // Profile grids: a square, cropped to the middle.
  thumb: { width: 480, height: 480, fit: "cover" },
};

/** Returns { buffer, contentType, width, height } for a re-encoded photo. */
async function processImage(input, size = "photo") {
  const spec = SIZES[size];
  if (!spec) throw new Error(`unknown image size ${size}`);
  let out;
  try {
    out = await sharp(input, { limitInputPixels: 50_000_000, failOn: "error" })
      .rotate() // upright, from the EXIF orientation (then the EXIF is dropped)
      .resize({ ...spec, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new ImageError("That doesn't look like a photo we can use (JPEG, PNG, WebP or GIF).");
  }
  return { buffer: out.data, contentType: "image/webp", width: out.info.width, height: out.info.height };
}

module.exports = { processImage, ImageError };
