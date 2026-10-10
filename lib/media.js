// Stored photos. On AWS they're kept in a private S3 bucket; on your own
// computer and in tests, in a folder. The site serves them itself at
// /media/<key>, so it decides who may see each one.
//
// Every photo is re-encoded first (images.js), so stored files are always
// WebP with no hidden data. Keys are random, so they can't be guessed.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEY = /^media\/[0-9a-f]{32}\.webp$/;

function newKey() {
  return `media/${crypto.randomBytes(16).toString("hex")}.webp`;
}

/** A folder-based store (your own computer, tests). */
function createDirStore(dir) {
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  const fileOf = (key) => path.join(dir, key);
  return {
    async put(key, buffer) {
      await fs.promises.writeFile(fileOf(key), buffer);
    },
    async get(key) {
      try {
        return await fs.promises.readFile(fileOf(key));
      } catch {
        return null;
      }
    },
    async remove(key) {
      await fs.promises.rm(fileOf(key), { force: true });
    },
  };
}

/** The S3 store (AWS). */
function createS3Store({ bucket, region }) {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
  const s3 = new S3Client({ region });
  return {
    async put(key, buffer, contentType = "image/webp") {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }));
    },
    async get(key) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return Buffer.from(await out.Body.transformToByteArray());
      } catch (err) {
        if (err.name === "NoSuchKey") return null;
        throw err;
      }
    },
    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

module.exports = { KEY, newKey, createDirStore, createS3Store };
