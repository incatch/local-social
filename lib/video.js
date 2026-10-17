// Video clips: re-encoded to a small, silent MP4 (no hidden data, no
// sound, so no music rights or overheard voices), with frames pulled out
// once a second so photo screening can check every one.
// Uses ffmpeg (installed in the container; `ffmpeg-static` on computers).

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { InputError } = require("./errors");

const MAX_SECONDS = 15;
const SIDE = 720; // the long side, in pixels

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}

class VideoError extends InputError {}

/** Runs ffmpeg; resolves with what it printed (it prints to stderr). */
function ffmpeg(args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => {
      err = (err + d).slice(-20000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(err);
      else reject(new Error(`ffmpeg failed (${code}): ${err.split("\n").slice(-4).join(" ")}`));
    });
  });
}

/** MP4/MOV (…ftyp…) or WebM/MKV. */
function isVideo(buffer) {
  if (!buffer || buffer.length < 12) return false;
  return buffer.subarray(4, 8).toString("latin1") === "ftyp" || buffer.readUInt32BE(0) === 0x1a45dfa3;
}

async function withTemp(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "radius-video-"));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/**
 * A clip from a phone → { video (MP4), poster (JPEG, first frame), frames
 * (JPEG, one a second, for screening), seconds }. Longer clips are cut to
 * the first 15 seconds.
 */
async function processClip(buffer, opts = {}) {
  try {
    return await readClip(buffer, opts);
  } catch (err) {
    if (err instanceof VideoError) throw err;
    throw new VideoError("We couldn't read that video. Try a different clip.");
  }
}

async function readClip(buffer, { maxSeconds = MAX_SECONDS } = {}) {
  return withTemp(async (dir) => {
    const input = path.join(dir, "in");
    await fs.promises.writeFile(input, buffer);
    const scale = `scale='if(gt(iw,ih),min(${SIDE},iw),-2)':'if(gt(iw,ih),-2,min(${SIDE},ih))'`;
    const log = await ffmpeg([
      "-i", input, "-t", String(maxSeconds), "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1",
      "-vf", `${scale},fps=30,format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
      "-movflags", "+faststart", path.join(dir, "out.mp4"),
    ]);
    const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(log);
    const seconds = m ? Math.min(maxSeconds, Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) : maxSeconds;
    if (seconds < 0.5) throw new VideoError("That clip is too short.");
    await ffmpeg(["-i", path.join(dir, "out.mp4"), "-vf", "fps=1,scale=640:-2", "-q:v", "4", path.join(dir, "f%02d.jpg")]);
    const names = (await fs.promises.readdir(dir)).filter((n) => /^f\d+\.jpg$/.test(n)).sort();
    const frames = await Promise.all(names.map((n) => fs.promises.readFile(path.join(dir, n))));
    await ffmpeg(["-i", path.join(dir, "out.mp4"), "-frames:v", "1", "-q:v", "2", path.join(dir, "poster.jpg")]);
    return {
      video: await fs.promises.readFile(path.join(dir, "out.mp4")),
      poster: await fs.promises.readFile(path.join(dir, "poster.jpg")),
      frames,
      seconds,
    };
  });
}

module.exports = { ffmpeg, ffmpegPath, isVideo, processClip, withTemp, VideoError, MAX_SECONDS };
