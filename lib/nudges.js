// Email nudges: a gentle email when messages are waiting, and a weekly
// "what's new around you" for people who've been away a few days.
// Never what a message says (they disappear), never more than one of each
// kind a day/week, and every email has a one-tap way to turn them off.

const crypto = require("crypto");

/** "2026-10-10" in the site's time zone. */
const dayIn = (timeZone, date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function offToken(secret, userId) {
  return crypto.createHmac("sha256", secret).update(`emails-off:${userId}`).digest("base64url").slice(0, 32);
}
function checkOffToken(secret, userId, token) {
  const expected = Buffer.from(offToken(secret, userId));
  const given = Buffer.from(String(token || ""));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Who sent what, in a few words: "Sam", "Sam and Alex", "Sam and 3 others". */
function whoSent(rows) {
  const names = rows.map((r) => r.display_name || `@${r.username}`);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

/** The email's frame: a short message, one button, and the way to turn them off. */
function frame({ siteName, lines, button, link, offLink }) {
  const text = `${lines.join("\n\n")}\n\n${button}: ${link}\n\n—\nDon't want these emails? Turn them off: ${offLink}\n`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#1c1b33">
<p style="font-size:20px;font-weight:700;color:#5b5fe0;margin:0 0 16px">${esc(siteName)}</p>
${lines.map((l) => `<p style="font-size:16px;line-height:1.5">${esc(l)}</p>`).join("")}
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#5b5fe0;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600">${esc(button)}</a></p>
<p style="font-size:12px;color:#777">Don't want these emails? <a href="${esc(offLink)}" style="color:#777">Turn them off</a>.</p>
</div>`;
  return { text, html };
}

function createNudges({ store, sendEmail, places, siteUrl, secret, timeZone, isTeen = () => false, log = console }) {
  const offLink = (userId) => `${siteUrl}/emails/off/${userId}/${offToken(secret, userId)}`;
  const headers = (userId) => ({ "List-Unsubscribe": `<${offLink(userId)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });

  async function messages(settings) {
    let sent = 0;
    for (const user of await store.claimMessageNudges()) {
      const from = await store.unreadFrom(user.id);
      if (!from.length) continue;
      const who = whoSent(from);
      const onlyRequests = from.every((r) => r.request);
      const subject = onlyRequests && from.length === 1 ? `${who} wants to message you` : `${who} sent you ${from.length === 1 && from[0].n === 1 ? "a message" : "messages"}`;
      const { text, html } = frame({
        siteName: settings.site_name,
        lines: [`Hi ${user.display_name},`, `${subject} on ${settings.site_name}.`],
        button: "Open messages",
        link: `${siteUrl}/messages`,
        offLink: offLink(user.id),
      });
      try {
        await sendEmail({ to: user.email, subject, text, html, headers: headers(user.id) });
        sent += 1;
      } catch (err) {
        log.error("message nudge failed", err);
      }
    }
    if (sent) await store.countEvent("nudge_messages", dayIn(timeZone), sent);
  }

  async function digests(settings) {
    let sent = 0;
    for (const user of await store.claimDigests()) {
      const teen = isTeen(user);
      const viewer = { ...user, min_radius: teen ? settings.teen_min_radius : 0, ai_filter: settings.nearby_ai_filter };
      const since = user.last_seen_at || user.created_at;
      const posts = await store.nearbyFeed(viewer, { s: settings, when: { since }, countOnly: true });
      const activity = await store.unseenActivity(user.id);
      if (!posts && !activity) continue;
      const town = String(places.nearestTown(user.feed_lat, user.feed_lon) || "you").split(",")[0];
      const subject = posts ? `${posts} new post${posts === 1 ? "" : "s"} around ${town}` : `You have ${activity} new notification${activity === 1 ? "" : "s"}`;
      const lines = [`Hi ${user.display_name},`];
      if (posts) lines.push(`Since you were last here, people around ${town} shared ${posts} new post${posts === 1 ? "" : "s"}.`);
      if (activity) lines.push(`You also have ${activity} new notification${activity === 1 ? "" : "s"}: likes, comments and new followers.`);
      const { text, html } = frame({ siteName: settings.site_name, lines, button: "See what's happening", link: `${siteUrl}/?tab=nearby`, offLink: offLink(user.id) });
      try {
        await sendEmail({ to: user.email, subject, text, html, headers: headers(user.id) });
        sent += 1;
      } catch (err) {
        log.error("digest failed", err);
      }
    }
    if (sent) await store.countEvent("nudge_digest", dayIn(timeZone), sent);
  }

  return {
    async run() {
      const settings = await store.settings();
      if (!settings.email_nudges_enabled) return;
      await messages(settings);
      await digests(settings);
    },
    offLink,
  };
}

module.exports = { createNudges, offToken, checkOffToken, dayIn, whoSent };
