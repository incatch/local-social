// Radius (this repository is local-social). Settings come from environment variables (set in
// infra/lib/local-social-stack.ts on AWS).

const http = require("http");
const { poolFromEnv, migrate, ensureDatabase } = require("./lib/db");
const { createStore } = require("./lib/store");
const { createSessions } = require("./lib/sessions");
const { createSesSender, consoleSender } = require("./lib/mailer");
const { createS3Store, createDirStore } = require("./lib/media");
const { createPlaces } = require("./lib/places");
const { createAlbAuth } = require("./lib/alb-auth");
const { createApp } = require("./lib/app");
const { createRekognitionScreener, allowAll } = require("./lib/screening");

async function main(env = process.env) {
  const region = env.AWS_REGION || "us-east-2";
  const siteUrl = env.SITE_URL || `http://localhost:${env.PORT || 8080}`;

  await ensureDatabase(env);
  const pool = poolFromEnv(env);
  await migrate(pool);
  const store = createStore(pool);

  const auth = env.LOAD_BALANCER_ARN
    ? createAlbAuth({ trustedSigner: env.LOAD_BALANCER_ARN, keysUrl: `https://public-keys.auth.elb.${region}.amazonaws.com` })
    : // On your own computer (LOCAL_ADMIN=yes): the owner is signed in to Admin.
      { signedInUser: async () => (env.LOCAL_ADMIN === "yes" ? { email: String(env.OWNER_EMAIL || "").toLowerCase() } : null) };
  const admins = [env.OWNER_EMAIL, ...String(env.ADMIN_EMAILS || "").split(",")].map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);

  const media = env.MEDIA_BUCKET ? createS3Store({ bucket: env.MEDIA_BUCKET, region }) : createDirStore(env.MEDIA_DIR || "./media-files");
  const handler = createApp({
    store,
    sessions: createSessions(env.SESSION_SECRET),
    sendEmail: env.EMAIL_FROM ? createSesSender({ region, from: env.EMAIL_FROM }) : consoleSender(),
    media,
    // Photo screening runs on AWS; on your own computer everything's allowed.
    screener: env.MEDIA_BUCKET && env.SCREENING !== "off" ? createRekognitionScreener({ region }) : allowAll,
    places: createPlaces(),
    auth,
    admins,
    secret: env.SESSION_SECRET,
    siteUrl,
    timeZone: env.SITE_TIME_ZONE || "America/Chicago",
    signOutUrl: env.SIGN_OUT_URL || null,
  });

  const port = Number(env.PORT || 8080);
  const server = http.createServer(handler);
  server.requestTimeout = 5 * 60 * 1000; // photo uploads on slow phone connections
  server.listen(port, () => console.log(`local social listening on port ${port}`));

  // Disappearing messages: every 10 minutes, delete the ones whose time is up
  // (and their snap photos). Safe to run in several containers at once.
  const purge = async () => {
    try {
      for (const key of await store.purgeMessages()) await media.remove(key).catch(() => {});
      for (const key of await store.purgeSnapWindows()) await media.remove(key).catch(() => {});
    } catch (err) {
      console.error("purging messages failed", err);
    }
  };
  setInterval(purge, 10 * 60 * 1000).unref();
  purge();

  // Email nudges (waiting messages, "what's new around you"): every 10 minutes.
  // Each person is claimed in the database first, so several containers never
  // send the same email.
  const nudge = () => handler.runNudges().catch((err) => console.error("email nudges failed", err));
  setInterval(nudge, 10 * 60 * 1000).unref();
  setTimeout(nudge, 60 * 1000).unref();

  // Phone notifications: send anything new every 5 seconds (each is claimed
  // in the database first, so it's sent once).
  let pushing = false;
  setInterval(async () => {
    if (pushing) return;
    pushing = true;
    try {
      await handler.runPush();
    } catch (err) {
      console.error("phone notifications failed", err);
    } finally {
      pushing = false;
    }
  }, 5000).unref();

  // Let Fargate stop the container cleanly during deploys.
  process.on("SIGTERM", () => server.close(() => pool.end().then(() => process.exit(0))));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
