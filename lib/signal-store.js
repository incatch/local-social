// Signals: quick text posts to the people around you (part of the store).
// Ask (neighbours answer; the asker can thank the best answer), Plan ("I'm
// in"), Lost & found, and Poll. Each reaches people within their own Nearby
// distance of where it was sent, follows the usual visibility rules
// (blocks, teen mode), and expires on its own.

const { InputError } = require("./errors");
const { canInteract } = require("./safety-store");

const KINDS = {
  ask: { label: "Ask", emoji: "❓", hours: 24 },
  plan: { label: "Plan", emoji: "🔥", hours: null }, // until 2 hours after the plan's time
  lost: { label: "Lost & found", emoji: "🐾", hours: 72 },
  poll: { label: "Poll", emoji: "📊", hours: 24 },
};
const MAX_BODY = 280;

const distance = (latA, lonA, latB, lonB) => `3958.8 * 2 * asin(sqrt(power(sin(radians(${latB} - ${latA}) / 2), 2)
  + cos(radians(${latA})) * cos(radians(${latB})) * power(sin(radians(${lonB} - ${lonA}) / 2), 2)))`;

function createSignalStore(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;

  // A signal as `$1` (the viewer) sees it.
  const COLUMNS = `s.*, u.username, u.display_name, u.photo_key as author_photo_key,
    (select count(*)::int from signal_replies r where r.signal_id = s.id) as reply_count,
    (select count(*)::int from signal_joins j where j.signal_id = s.id) as join_count,
    exists (select 1 from signal_joins j where j.signal_id = s.id and j.user_id = $1) as joined,
    (select choice from signal_votes v where v.signal_id = s.id and v.user_id = $1) as my_vote,
    (select coalesce(json_agg(json_build_object('choice', choice, 'n', n)), '[]') from
       (select choice, count(*)::int as n from signal_votes v where v.signal_id = s.id group by choice) t) as votes`;
  const LIVE = `s.status = 'visible' and s.expires_at > now() and u.status = 'active' and ${canInteract("$1", "s.user_id")}`;

  return {
    /** Sends a signal from `place` (already rounded). */
    async createSignal(userId, { kind, body, planAt = null, options = null, place, areaName }) {
      if (!KINDS[kind]) throw new InputError("Pick what kind of signal this is.");
      body = String(body || "").trim().replace(/\r\n/g, "\n");
      if (!body) throw new InputError("Please write something.");
      if (body.length > MAX_BODY) throw new InputError(`Keep it to ${MAX_BODY} characters.`);
      if (!place) throw new InputError("Set your location on Nearby first, so we know who's around you.");
      let expires = new Date(Date.now() + (KINDS[kind].hours || 0) * 3600 * 1000);
      if (kind === "plan") {
        const at = planAt ? new Date(planAt) : null;
        if (!at || Number.isNaN(at.getTime())) throw new InputError("When is it?");
        if (at < new Date(Date.now() - 15 * 60 * 1000)) throw new InputError("That time has already passed.");
        if (at > new Date(Date.now() + 7 * 86400 * 1000)) throw new InputError("Plans can be up to a week ahead.");
        planAt = at;
        expires = new Date(at.getTime() + 2 * 3600 * 1000);
      } else planAt = null;
      if (kind === "poll") {
        options = (options || []).map((o) => String(o || "").trim().slice(0, 60)).filter(Boolean);
        if (options.length < 2) throw new InputError("Give at least two choices.");
        options = options.slice(0, 4);
      } else options = null;
      return one(
        `insert into signals (user_id, kind, body, plan_at, options, lat, lon, area_name, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
        [userId, kind, body, planAt, options ? JSON.stringify(options) : null, place.lat, place.lon, areaName, expires],
      );
    },

    /** Live signals around the viewer (within their Nearby distance), newest first. */
    async signalsNear(viewer, { kind = null, limit = 50 } = {}) {
      if (viewer.feed_lat === null || viewer.feed_lat === undefined) return [];
      const radius = Math.max(viewer.feed_radius_miles, viewer.min_radius || 0);
      const { rows } = await q(
        `select ${COLUMNS} from signals s join users u on u.id = s.user_id
          where ${LIVE} and ($5::text is null or s.kind = $5)
            and ${distance("$2", "$3", "s.lat", "s.lon")} <= $4
          order by (s.kind = 'lost') desc, s.created_at desc limit $6`,
        [viewer.id, viewer.feed_lat, viewer.feed_lon, radius, kind, limit],
      );
      return rows;
    },
    async signal(id, viewerId) {
      if (!/^\d{1,18}$/.test(String(id))) return null;
      return one(`select ${COLUMNS} from signals s join users u on u.id = s.user_id where s.id = $2 and ${LIVE}`, [viewerId, id]);
    },
    async signalReplies(signalId, viewerId) {
      return (
        await q(
          `select r.*, u.username, u.display_name, u.photo_key from signal_replies r join users u on u.id = r.user_id
            where r.signal_id = $2 and u.status = 'active' and ${canInteract("$1", "r.user_id")}
            order by r.thanked desc, r.created_at`,
          [viewerId, signalId],
        )
      ).rows;
    },
    async replyToSignal(signal, userId, body) {
      body = String(body || "").trim().replace(/\r\n/g, "\n");
      if (!body) throw new InputError("Please write a reply.");
      if (body.length > 500) throw new InputError("Replies can be up to 500 characters.");
      const reply = await one("insert into signal_replies (signal_id, user_id, body) values ($1, $2, $3) returning *", [signal.id, userId, body]);
      if (String(signal.user_id) !== String(userId)) {
        await q("insert into notifications (user_id, actor_id, kind, signal_id) values ($1, $2, 'answer', $3)", [signal.user_id, userId, signal.id]);
      }
      return reply;
    },
    /** The asker thanks a reply (once). */
    async thankReply(signal, replyId, userId) {
      if (String(signal.user_id) !== String(userId)) throw new InputError("Only the person who asked can say thanks.");
      const reply = await one("update signal_replies set thanked = true where id = $1 and signal_id = $2 and not thanked returning *", [replyId, signal.id]);
      if (reply && String(reply.user_id) !== String(userId)) {
        await q("insert into notifications (user_id, actor_id, kind, signal_id) values ($1, $2, 'thanks', $3)", [reply.user_id, userId, signal.id]);
      }
    },
    /** "I'm in" (or not any more) on a plan. Returns whether they're in now. */
    async toggleJoin(signal, userId) {
      if (signal.kind !== "plan") throw new InputError("That isn't a plan.");
      const gone = await q("delete from signal_joins where signal_id = $1 and user_id = $2", [signal.id, userId]);
      if (gone.rowCount) return false;
      await q("insert into signal_joins (signal_id, user_id) values ($1, $2) on conflict do nothing", [signal.id, userId]);
      if (String(signal.user_id) !== String(userId)) {
        await q(
          `insert into notifications (user_id, actor_id, kind, signal_id) select $1, $2, 'flare', $3
            where not exists (select 1 from notifications where kind = 'flare' and actor_id = $2 and signal_id = $3)`,
          [signal.user_id, userId, signal.id],
        );
      }
      return true;
    },
    async vote(signal, userId, choice) {
      const c = Number(choice);
      if (signal.kind !== "poll" || !Number.isInteger(c) || c < 0 || c >= (signal.options || []).length) throw new InputError("Pick one of the choices.");
      await q("insert into signal_votes (signal_id, user_id, choice) values ($1, $2, $3) on conflict (signal_id, user_id) do update set choice = excluded.choice", [signal.id, userId, c]);
    },
    async deleteSignal(signalId, userId) {
      const gone = await one("delete from signals where id = $1 and user_id = $2 returning id", [signalId, userId]);
      if (!gone) throw new InputError("You can only delete your own.");
    },
    async removeSignal(signalId) {
      await q("update signals set status = 'removed' where id = $1", [signalId]);
    },
    async signalForModeration(id) {
      return one("select s.*, u.username from signals s join users u on u.id = s.user_id where s.id = $1", [id]);
    },
  };
}

module.exports = { createSignalStore, SIGNAL_KINDS: KINDS };
