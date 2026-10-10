// Drops and Where It's At (part of the store).

const { InputError } = require("./errors");
const { canInteract } = require("./safety-store");

const MAX_LIVE_DROPS = 5;
const distance = (lat, lon, t = "d") => `3958.8 * 2 * asin(sqrt(power(sin(radians(${t}.lat - ${lat}) / 2), 2)
  + cos(radians(${lat})) * cos(radians(${t}.lat)) * power(sin(radians(${t}.lon - ${lon}) / 2), 2)))`;
const LIVE = "d.status = 'visible' and d.expires_at > now() and u.status = 'active'";

function createDropStore(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;
  const COLUMNS = `d.*, u.username, u.display_name, u.photo_key as author_photo_key,
    (select count(*)::int from drop_finds f where f.drop_id = d.id) as finds,
    exists (select 1 from drop_finds f where f.drop_id = d.id and f.user_id = $1) as found`;

  return {
    // ── Public places (cache) ────────────────────────────────────────────
    async cachedPlaces(cell) {
      const row = await one("select places from places_cache where cell = $1 and fetched_at > now() - interval '30 days'", [cell]);
      return row ? row.places : null;
    },
    async savePlaces(cell, places) {
      await q("insert into places_cache (cell, places) values ($1, $2) on conflict (cell) do update set places = excluded.places, fetched_at = now()", [cell, JSON.stringify(places)]);
    },

    // ── Drops ────────────────────────────────────────────────────────────
    async createDrop(userId, { place, note, photoKey }) {
      const text = String(note || "").trim().replace(/\s+/g, " ");
      if (text.length > 140) throw new InputError("Keep the note under 140 characters.");
      if (!text && !photoKey) throw new InputError("Add a photo or a note to leave here.");
      const live = await one("select count(*)::int as n from drops where user_id = $1 and status = 'visible' and expires_at > now()", [userId]);
      if (live.n >= MAX_LIVE_DROPS) throw new InputError(`You have ${MAX_LIVE_DROPS} Drops out there already. Wait for one to expire, or delete one.`);
      return one(
        "insert into drops (user_id, place_name, place_kind, lat, lon, note, photo_key) values ($1, $2, $3, $4, $5, $6, $7) returning *",
        [userId, place.name, place.kind || "", place.lat, place.lon, text, photoKey || null],
      );
    },
    /** Drops near a spot that the viewer can see (not their own), nearest first. */
    async dropsNear(viewer, { lat, lon, miles = 5 }) {
      if (lat === null || lat === undefined) return [];
      return (
        await q(
          `select ${COLUMNS}, ${distance("$2", "$3")} as miles
             from drops d join users u on u.id = d.user_id
            where ${LIVE} and d.user_id <> $1 and ${canInteract("$1", "d.user_id")}
              and d.lat between $2 - $4 / 69.0 and $2 + $4 / 69.0
              and ${distance("$2", "$3")} <= $4
            order by miles limit 50`,
          [viewer.id, lat, lon, miles],
        )
      ).rows;
    },
    async myDrops(userId) {
      return (await q(`select ${COLUMNS} from drops d join users u on u.id = d.user_id where d.user_id = $1 and ${LIVE} order by d.created_at desc`, [userId])).rows;
    },
    async drop(id, viewerId) {
      if (!/^\d{1,18}$/.test(String(id))) return null;
      return one(`select ${COLUMNS} from drops d join users u on u.id = d.user_id where d.id = $2 and ${LIVE} and ${canInteract("$1", "d.user_id")}`, [viewerId, id]);
    },
    /** Opens a Drop. The person who left it hears that someone found it, never who. */
    async findDrop(drop, userId) {
      const row = await one("insert into drop_finds (drop_id, user_id) values ($1, $2) on conflict do nothing returning *", [drop.id, userId]);
      if (row) {
        const n = await one("select count(*)::int as n from drop_finds where drop_id = $1", [drop.id]);
        await q("insert into notifications (user_id, actor_id, kind, drop_id, detail) values ($1, $1, 'drop_found', $2, $3)", [drop.user_id, drop.id, String(n.n)]);
      }
      return Boolean(row);
    },
    /** The Drops someone has found ("Found it" stamps), newest first. */
    async dropStamps(userId) {
      return (
        await q(
          `select d.id, d.place_name, d.place_kind, f.found_at from drop_finds f join drops d on d.id = f.drop_id
            where f.user_id = $1 and d.status = 'visible' order by f.found_at desc limit 100`,
          [userId],
        )
      ).rows;
    },
    async deleteDrop(id, userId) {
      const row = await one("update drops set status = 'removed' where id = $1 and user_id = $2 returning photo_key", [id, userId]);
      return row ? row.photo_key : null;
    },

    // ── Where It's At ────────────────────────────────────────────────────
    /**
     * Spots glowing right now: posts (that can be on Nearby) from the last
     * 3 hours but at least 30 minutes old, grouped by their rounded spot,
     * only where `minPeople` different adults posted. Teens' posts never count.
     */
    async heatSpots(viewer, { minPeople = 3, miles = 25 } = {}) {
      if (viewer.feed_lat === null || viewer.feed_lat === undefined) return [];
      const spots = (
        await q(
          `select round(p.lat::numeric, 4)::float as lat, round(p.lon::numeric, 4)::float as lon,
                  count(*)::int as posts, count(distinct p.user_id)::int as people, max(p.area_name) as area_name,
                  (array_agg(p.id order by p.like_count + p.comment_count desc, p.created_at desc))[1:4] as post_ids
             from posts p join users u on u.id = p.user_id and u.status = 'active'
            where p.status = 'visible' and p.lat is not null and ((p.nearby_ok and not p.ai_made) or p.nearby_override)
              and p.created_at > now() - interval '3 hours' and p.created_at < now() - interval '30 minutes'
              and (u.teen_until is null or u.teen_until <= current_date)
              and p.lat between $2 - $4 / 69.0 and $2 + $4 / 69.0
              and ${distance("$2", "$3", "p")} <= $4
              and ${canInteract("$1", "p.user_id")}
            group by 1, 2
           having count(distinct p.user_id) >= $5
            order by posts desc limit 40`,
          [viewer.id, viewer.feed_lat, viewer.feed_lon, miles, minPeople],
        )
      ).rows;
      const ids = spots.flatMap((s) => s.post_ids);
      const thumbs = ids.length
        ? Object.fromEntries(
            (await q("select distinct on (post_id) post_id, thumb_key from post_photos where post_id = any($1::bigint[]) order by post_id, position", [ids])).rows.map((r) => [r.post_id, r.thumb_key]),
          )
        : {};
      return spots.map((s) => ({ ...s, posts_shown: s.post_ids.map((id) => ({ id, thumb: thumbs[id] })).filter((x) => x.thumb) }));
    },
  };
}

module.exports = { createDropStore, MAX_LIVE_DROPS };
