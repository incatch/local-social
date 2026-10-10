// Beta polish (part of the store): people search, feedback, email nudges and
// the numbers on Admin → Beta.

const { InputError } = require("./errors");
const { canInteract } = require("./safety-store");

const FEEDBACK_KINDS = { idea: "💡 Idea", problem: "🐞 Something's wrong", other: "💬 Something else" };

// Who can get emails: finished joining, not banned, not a teen still waiting for a parent.
const REACHABLE = `u.status = 'active' and u.username is not null and u.email_nudges
  and (not u.needs_parent_consent or u.parent_consent_at is not null)`;

const likeText = (text) => String(text || "").replace(/[\\%_]/g, (c) => `\\${c}`);

function createBetaStore(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;

  return {
    // ── Using the site ───────────────────────────────────────────────────
    /** Marks someone as here now, and today as a day they used the site. */
    async recordActive(userId, day) {
      await q("update users set last_seen_at = now() where id = $1", [userId]);
      await q("insert into active_days (user_id, day) values ($1, $2) on conflict do nothing", [userId, day]);
    },
    async countEvent(kind, day, n = 1) {
      await q("insert into daily_counts (day, kind, n) values ($1, $2, $3) on conflict (day, kind) do update set n = daily_counts.n + excluded.n", [day, kind, n]);
    },

    // ── People search ────────────────────────────────────────────────────
    /** People by username or name, best matches first. Only people the viewer can see. */
    async searchPeople(viewer, text, limit = 30) {
      const term = String(text || "").trim().replace(/^@/, "").toLowerCase().slice(0, 50);
      if (!term) return [];
      return (
        await q(
          `select u.id, u.username, u.display_name, u.photo_key, u.area_name,
                  exists (select 1 from follows f where f.follower_id = $1 and f.followee_id = u.id) as followed,
                  (select count(*)::int from follows f where f.followee_id = u.id) as followers
             from users u
            where u.username is not null and u.status = 'active' and u.id <> $1
              and (not u.needs_parent_consent or u.parent_consent_at is not null)
              and (u.username like $2 || '%' escape '\\' or lower(u.display_name) like '%' || $2 || '%' escape '\\')
              and ${canInteract("$1", "u.id")}
            order by (u.username = $3) desc, (u.username like $2 || '%' escape '\\') desc, followers desc, u.username
            limit $4`,
          [viewer.id, likeText(term), term, limit],
        )
      ).rows;
    },
    /** People around the viewer they don't follow yet, the ones who post most first. */
    async peopleNearby(viewer, limit = 12) {
      if (viewer.feed_lat === null || viewer.feed_lat === undefined) return [];
      const miles = Math.max(25, viewer.feed_radius_miles || 0);
      return (
        await q(
          `select u.id, u.username, u.display_name, u.photo_key, u.area_name, false as followed,
                  (select count(*)::int from posts p where p.user_id = u.id and p.status = 'visible' and p.created_at > now() - interval '30 days') as recent_posts
             from users u
            where u.username is not null and u.status = 'active' and u.id <> $1
              and (not u.needs_parent_consent or u.parent_consent_at is not null)
              and coalesce(u.feed_lat, u.area_lat) is not null
              and 3958.8 * 2 * asin(sqrt(power(sin(radians(coalesce(u.feed_lat, u.area_lat) - $2) / 2), 2)
                  + cos(radians($2)) * cos(radians(coalesce(u.feed_lat, u.area_lat))) * power(sin(radians(coalesce(u.feed_lon, u.area_lon) - $3) / 2), 2))) <= $4
              and not exists (select 1 from follows f where f.follower_id = $1 and f.followee_id = u.id)
              and ${canInteract("$1", "u.id")}
            order by recent_posts desc, u.last_seen_at desc nulls last
            limit $5`,
          [viewer.id, viewer.feed_lat, viewer.feed_lon, miles, limit],
        )
      ).rows;
    },

    // ── Feedback ─────────────────────────────────────────────────────────
    async addFeedback(userId, { kind, body, page = "", device = "" }) {
      const text = String(body || "").trim();
      if (!FEEDBACK_KINDS[kind]) throw new InputError("Please pick what kind of feedback this is.");
      if (text.length < 3) throw new InputError("Please write a few words.");
      if (text.length > 2000) throw new InputError("Please keep it under 2,000 characters.");
      const recent = await one("select count(*)::int as n from feedback where user_id = $1 and created_at > now() - interval '1 hour'", [userId]);
      if (recent.n >= 10) throw new InputError("Thanks, that's a lot of feedback! Please wait a bit before sending more.");
      const page_ = String(page || "").startsWith("/") ? String(page).slice(0, 200) : "";
      return one("insert into feedback (user_id, kind, body, page, device) values ($1, $2, $3, $4, $5) returning *", [userId, kind, text, page_, String(device || "").slice(0, 300)]);
    },
    async feedbackList({ done = false, limit = 100 } = {}) {
      return (
        await q(
          `select f.*, u.username, u.display_name, u.photo_key, u.email
             from feedback f left join users u on u.id = f.user_id
            where (f.done_at is not null) = $1
            order by ${done ? "f.done_at" : "f.created_at"} desc limit $2`,
          [done, limit],
        )
      ).rows;
    },
    async setFeedbackDone(id, done) {
      await q(`update feedback set done_at = ${done ? "now()" : "null"} where id = $1`, [id]);
    },

    // ── Email nudges ─────────────────────────────────────────────────────
    async setEmailNudges(userId, on) {
      await q("update users set email_nudges = $2 where id = $1", [userId, Boolean(on)]);
    },
    /**
     * People with messages they haven't seen, sent since their last visit,
     * who've been away at least an hour. At most one email a day each, and
     * only about messages newer than the last email. Claims them, so two
     * containers never email the same person.
     */
    async claimMessageNudges(limit = 100) {
      return (
        await q(
          `update users u set messages_nudged_at = now()
            where u.id in (
              select u.id from users u
               where ${REACHABLE}
                 and coalesce(u.last_seen_at, u.created_at) < now() - interval '1 hour'
                 and (u.messages_nudged_at is null or u.messages_nudged_at < now() - interval '20 hours')
                 and exists (
                   select 1 from messages m join conversations c on c.id = m.conversation_id
                    where u.id in (c.user_a, c.user_b) and m.sender_id <> u.id and m.read_at is null
                      and m.created_at > coalesce(u.last_seen_at, u.created_at)
                      and m.created_at < now() - interval '15 minutes'
                      and (u.messages_nudged_at is null or m.created_at > u.messages_nudged_at)
                      and ${canInteract("u.id", "m.sender_id")})
               limit $1
               for update skip locked)
          returning u.*`,
          [limit],
        )
      ).rows;
    },
    /** Who's waiting to hear from you: names of the people with unread messages. */
    async unreadFrom(userId) {
      return (
        await q(
          `select s.display_name, s.username, count(*)::int as n, (c.accepted_at is null and c.started_by <> $1) as request
             from messages m join conversations c on c.id = m.conversation_id join users s on s.id = m.sender_id
            where $1 in (c.user_a, c.user_b) and m.sender_id <> $1 and m.read_at is null and ${canInteract("$1", "m.sender_id")}
            group by s.id, c.id order by max(m.created_at) desc`,
          [userId],
        )
      ).rows;
    },
    /**
     * People who haven't been here for 3+ days and have a Nearby spot: once a
     * week at most, "what's new around you". Claims them like the above.
     */
    async claimDigests(limit = 100) {
      return (
        await q(
          `update users u set digest_sent_at = now()
            where u.id in (
              select u.id from users u
               where ${REACHABLE} and u.feed_lat is not null
                 and u.created_at < now() - interval '2 days'
                 and coalesce(u.last_seen_at, u.created_at) < now() - interval '3 days'
                 and (u.digest_sent_at is null or u.digest_sent_at < now() - interval '7 days')
               limit $1
               for update skip locked)
          returning u.*`,
          [limit],
        )
      ).rows;
    },

    // ── Admin → Beta ─────────────────────────────────────────────────────
    async setSetting(key, value) {
      await q("insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, String(value)]);
    },
    async betaStats(timeZone) {
      const today = `(now() at time zone '${timeZone.replace(/'/g, "")}')::date`;
      const local = (col) => `(${col} at time zone '${timeZone.replace(/'/g, "")}')::date`;
      const totals = await one(
        `select (select count(*)::int from users where username is not null and status = 'active') as members,
                (select count(*)::int from users where username is not null and status = 'active' and created_at > now() - interval '7 days') as new_week,
                (select count(distinct user_id)::int from active_days where day = ${today}) as active_today,
                (select count(distinct user_id)::int from active_days where day > ${today} - 7) as active_week,
                (select count(distinct user_id)::int from active_days where day > ${today} - 30) as active_month,
                (select count(*)::int from users u where username is not null and ${local("u.created_at")} < ${today} - 1) as came_back_of,
                (select count(*)::int from users u where username is not null and ${local("u.created_at")} < ${today} - 1
                    and (select count(*) from active_days a where a.user_id = u.id) >= 2) as came_back,
                (select count(*)::int from users u where username is not null and u.created_at < now() - interval '7 days') as stayed_of,
                (select count(*)::int from users u where username is not null and u.created_at < now() - interval '7 days'
                    and exists (select 1 from active_days a where a.user_id = u.id and a.day > ${today} - 7)) as stayed,
                (select count(*)::int from users u join invites i on i.id = u.invite_id where i.created_by is not null and u.username is not null) as from_members,
                (select count(*)::int from users where username is not null and status = 'active' and not email_nudges) as nudges_off,
                (select count(*)::int from feedback where done_at is null) as open_feedback`,
      );
      const days = (
        await q(
          `select d::date as day,
                  (select count(*)::int from active_days a where a.day = d::date) as active,
                  (select count(*)::int from users u where u.username is not null and ${local("u.created_at")} = d::date) as joined,
                  (select count(*)::int from posts p where p.status <> 'removed' and ${local("p.created_at")} = d::date) as posts,
                  (select count(*)::int from comments c where ${local("c.created_at")} = d::date) as comments,
                  (select coalesce(sum(n), 0)::int from daily_counts k where k.day = d::date and k.kind = 'message') as messages,
                  (select count(*)::int from signals s where ${local("s.created_at")} = d::date) as signals,
                  (select coalesce(sum(n), 0)::int from daily_counts k where k.day = d::date and k.kind like 'nudge_%') as emails
             from generate_series(${today} - 13, ${today}, interval '1 day') d
            order by d desc`,
        )
      ).rows;
      const towns = (
        await q(
          `select split_part(area_name, ',', 1) || coalesce(', ' || nullif(trim(split_part(area_name, ',', 2)), ''), '') as town,
                  count(*)::int as posts, count(distinct user_id)::int as people
             from posts where area_name is not null and status <> 'removed' and created_at > now() - interval '30 days'
            group by 1 order by posts desc limit 8`,
        )
      ).rows;
      return { ...totals, days, towns };
    },
  };
}

module.exports = { createBetaStore, FEEDBACK_KINDS };
