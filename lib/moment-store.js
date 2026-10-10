// Moments: shared albums that make themselves (part of the store).
//
// When enough different people post from close by within a few hours, their
// posts become a Moment ("Friday night in Springfield"), and later posts
// from the same spot while it's going on join it. Only posts that can be on
// Nearby count (not political, not AI-made). Each viewer only ever sees the
// posts they're allowed to (blocks, teen mode), counted for them.

const { canInteract } = require("./safety-store");

const distance = (lat, lon) => `3958.8 * 2 * asin(sqrt(power(sin(radians(p.lat - ${lat}) / 2), 2)
  + cos(radians(${lat})) * cos(radians(p.lat)) * power(sin(radians(p.lon - ${lon}) / 2), 2)))`;
const NEARBY_OK = "p.status = 'visible' and p.lat is not null and ((p.nearby_ok and not p.ai_made) or p.nearby_override)";

/** "Friday night", "Saturday morning"… in the site's time zone. */
function whenName(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", hour: "numeric", hour12: false }).formatToParts(date);
  const day = parts.find((p) => p.type === "weekday").value;
  const hour = Number(parts.find((p) => p.type === "hour").value) % 24;
  const part = hour < 5 ? "night" : hour < 11 ? "morning" : hour < 14 ? "midday" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night";
  return `${day} ${part}`;
}
function momentTitle(date, areaName, timeZone) {
  const town = String(areaName || "").split(",")[0] || "town";
  return `${whenName(date, timeZone)} in ${town}`;
}

function createMomentStore(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;

  return {
    /**
     * Puts a new post in a Moment if it belongs to one (joining one going on
     * nearby, or starting one with recent posts around it). Returns
     * { moment, started, posterIds } or null.
     */
    async attachToMoment(post, s, { timeZone = "America/Chicago" } = {}) {
      if (!s.moments_enabled || post.lat === null) return null;
      const eligible = await one(`select 1 from posts p where p.id = $1 and ${NEARBY_OK}`, [post.id]);
      if (!eligible) return null;
      // A Moment still going on close by?
      const going = await one(
        `select m.* from moments m
          where m.last_post_at > now() - make_interval(hours => $3::int)
            and 3958.8 * 2 * asin(sqrt(power(sin(radians(m.lat - $1) / 2), 2) + cos(radians($1)) * cos(radians(m.lat)) * power(sin(radians(m.lon - $2) / 2), 2))) <= $4
          order by m.last_post_at desc limit 1`,
        [post.lat, post.lon, s.moment_hours, s.moment_miles],
      );
      if (going) {
        await q("insert into moment_posts (moment_id, post_id) values ($1, $2) on conflict do nothing", [going.id, post.id]);
        await q("update moments set last_post_at = now() where id = $1", [going.id]);
        return { moment: going, started: false, posterIds: [post.user_id] };
      }
      // Enough people posting around here lately to start one?
      const { rows } = await q(
        `select p.id, p.user_id from posts p
          where ${NEARBY_OK} and p.created_at > now() - make_interval(hours => $3::int)
            and ${distance("$1", "$2")} <= $4
            and not exists (select 1 from moment_posts mp where mp.post_id = p.id)`,
        [post.lat, post.lon, s.moment_hours, s.moment_miles],
      );
      const people = new Set(rows.map((r) => String(r.user_id)));
      if (people.size < s.moment_people) return null;
      const moment = await one("insert into moments (lat, lon, area_name, title) values ($1, $2, $3, $4) returning *", [
        post.lat,
        post.lon,
        post.area_name,
        momentTitle(new Date(), post.area_name, timeZone),
      ]);
      for (const r of rows) await q("insert into moment_posts (moment_id, post_id) values ($1, $2) on conflict do nothing", [moment.id, r.id]);
      return { moment, started: true, posterIds: [...people] };
    },

    /** Tells posters their photos are part of a Moment. */
    async notifyMoment(momentId, userIds) {
      for (const uid of userIds) {
        await q(
          `insert into notifications (user_id, actor_id, kind, detail) select $1, $1, 'moment', $2
            where not exists (select 1 from notifications where user_id = $1 and kind = 'moment' and detail = $2)`,
          [uid, String(momentId)],
        );
      }
    },

    /** Moments within the viewer's radius from the last day, with what they may see of each. */
    async momentsNear(viewer, { hours = 24, limit = 5 } = {}) {
      if (viewer.feed_lat === null || viewer.feed_lat === undefined) return [];
      const radius = Math.max(viewer.feed_radius_miles, viewer.min_radius || 0);
      const { rows } = await q(
        `select m.*,
                count(p.id)::int as photos, count(distinct p.user_id)::int as people,
                (array_agg((select thumb_key from post_photos pp where pp.post_id = p.id order by position limit 1) order by p.like_count desc, p.id desc))[1:4] as thumbs
           from moments m
           join moment_posts mp on mp.moment_id = m.id
           join posts p on p.id = mp.post_id and ${NEARBY_OK}
           join users u on u.id = p.user_id and u.status = 'active'
          where m.last_post_at > now() - make_interval(hours => $4::int)
            and ${canInteract("$1", "p.user_id")}
            and 3958.8 * 2 * asin(sqrt(power(sin(radians(m.lat - $2) / 2), 2) + cos(radians($2)) * cos(radians(m.lat)) * power(sin(radians(m.lon - $3) / 2), 2))) <= $5
          group by m.id
          having count(distinct p.user_id) >= 2
          order by m.last_post_at desc limit $6`,
        [viewer.id, viewer.feed_lat, viewer.feed_lon, hours, radius, limit],
      );
      return rows;
    },

    async moment(id) {
      if (!/^\d{1,18}$/.test(String(id))) return null;
      return one("select * from moments where id = $1", [id]);
    },
    /** A Moment's posts the viewer may see, best first (with photos added by the caller). */
    async momentPostIds(momentId, viewerId) {
      const { rows } = await q(
        `select p.id from moment_posts mp join posts p on p.id = mp.post_id and ${NEARBY_OK}
           join users u on u.id = p.user_id and u.status = 'active'
          where mp.moment_id = $1 and ${canInteract("$2", "p.user_id")}
          order by p.created_at, p.id`,
        [momentId, viewerId],
      );
      return rows.map((r) => r.id);
    },
    async momentOfPost(postId) {
      return one("select m.* from moment_posts mp join moments m on m.id = mp.moment_id where mp.post_id = $1", [postId]);
    },
  };
}

module.exports = { createMomentStore, momentTitle, whenName };
