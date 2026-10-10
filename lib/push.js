// Phone notifications (web push). Works on Android and computers in the
// browser, and on iPhone once Radius is added to the Home Screen.
//
// The push keys (VAPID) are worked out from the site's secret, so there's
// no extra secret to look after. Never put what a message says in a
// notification: lock screens are public.

const crypto = require("crypto");
const webpush = require("web-push");

// The order of the P-256 curve: a private key must be below it.
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

/** The site's push keys, derived from its secret (the same on every container). */
function vapidKeys(secret) {
  let seed = crypto.createHmac("sha256", String(secret)).update("radius-web-push-vapid").digest();
  while (BigInt(`0x${seed.toString("hex")}`) >= P256_ORDER || seed.every((b) => b === 0)) seed = crypto.createHash("sha256").update(seed).digest();
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(seed);
  return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: seed.toString("base64url") };
}

/** Sends one notification with the web-push library. */
function webPushSender({ keys, contact }) {
  return (subscription, payload) =>
    webpush.sendNotification(subscription, payload, {
      TTL: 6 * 60 * 60,
      urgency: "normal",
      vapidDetails: { subject: contact, publicKey: keys.publicKey, privateKey: keys.privateKey },
    });
}

const short = (s, n = 80) => (String(s || "").length > n ? `${String(s).slice(0, n)}…` : String(s || ""));

/** The words and link for a notification (see activityLine in message-views.js). */
function notificationText(n) {
  const who = n.actor_display_name || `@${n.actor_username}`;
  const post = n.post_id ? `/p/${n.post_id}` : null;
  switch (n.kind) {
    case "like":
      return { body: `${who} liked your post`, url: post };
    case "comment":
      return { body: `${who} commented: “${short(n.comment_body)}”`, url: n.comment_id ? `${post}#c${n.comment_id}` : post };
    case "follow":
      return { body: `${who} started following you`, url: `/@${n.actor_username}` };
    case "mention":
      return { body: `${who} mentioned you`, url: post };
    case "moment":
      return { body: `Your photo is part of a Moment: ${n.moment_title || "see everyone's photos"}`, url: `/m/${n.detail}` };
    case "answer":
      return { body: `${who} answered your ${n.signal_kind === "lost" ? "lost & found" : "question"}`, url: `/s/${n.signal_id}` };
    case "thanks":
      return { body: `${who} 🙏 thanked you for your answer`, url: `/s/${n.signal_id}` };
    case "flare":
      return { body: `${who} is in for your plan 🔥`, url: `/s/${n.signal_id}` };
    case "badge": {
      const b = require("./badges").BY_KEY[n.detail];
      return { body: b ? `You earned a badge: ${b.emoji} ${b.name}` : "You earned a badge", url: "/badges" };
    }
    case "ripple":
      return { body: `Your post rippled out to ${n.detail} miles 🌊`, url: post };
    default:
      return { body: `${who} · new activity`, url: "/activity" };
  }
}

function createPush({ store, secret, siteName = "Radius", contact = "mailto:support@plopza.com", sender = null, log = console }) {
  const keys = vapidKeys(secret);
  const send = sender || webPushSender({ keys, contact });

  /** Sends to every device the person turned notifications on for. Returns how many got it. */
  async function toUser(userId, note) {
    let delivered = 0;
    const payload = JSON.stringify({ title: note.title || siteName, body: note.body, url: note.url || "/", tag: note.tag || undefined });
    for (const sub of await store.pushSubscriptions(userId)) {
      try {
        await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        await store.pushSent(sub.id);
        delivered += 1;
      } catch (err) {
        // The browser has forgotten this subscription (turned off, app removed).
        if (err && (err.statusCode === 404 || err.statusCode === 410)) await store.dropPushSubscription(sub.id);
        else log.error("push failed", err && err.statusCode ? `status ${err.statusCode}` : err);
      }
    }
    return delivered;
  }

  return {
    publicKey: keys.publicKey,
    toUser,
    /** Sends everything new. Run every few seconds; safe in several containers at once. */
    async run() {
      for (const n of await store.claimPushNotifications()) {
        const t = notificationText(n);
        await toUser(n.user_id, { body: t.body, url: t.url || "/activity", tag: `n${n.id}` });
      }
      for (const m of await store.claimPushMessages()) {
        const who = m.sender_display_name || `@${m.sender_username}`;
        const body = m.request ? `${who} wants to message you` : m.kind === "snap" ? `${who} sent you a photo 📷` : `${who} sent you a message`;
        // One notification per chat at a time (newer ones replace older ones).
        await toUser(m.user_id, { body, url: m.request ? "/messages/requests" : `/messages/${m.conversation_id}`, tag: `c${m.conversation_id}` });
      }
    },
  };
}

module.exports = { createPush, vapidKeys, notificationText };
