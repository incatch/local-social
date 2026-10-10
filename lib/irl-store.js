// Pull Up and Squads (part of the store): doing real things together.

const { InputError } = require("./errors");
const { canInteract } = require("./safety-store");

const SQUAD_MAX = 8;
const SQUAD_EMOJI = ["🫂", "🔥", "⚡️", "🌊", "🛹", "🏀", "🎸", "🌮", "🎮", "🌙", "🌻", "👾"];
// Two posts count as "together" when they're this close in miles (the
// rounded spots are about a mile apart) and this close in time.
const TOGETHER_MILES = 1.5;
const TOGETHER_HOURS = 2;

const dist = (a, b) => `3958.8 * 2 * asin(sqrt(power(sin(radians(${b}.lat - ${a}.lat) / 2), 2)
  + cos(radians(${a}.lat)) * cos(radians(${b}.lat)) * power(sin(radians(${b}.lon - ${a}.lon) / 2), 2)))`;

/** Consecutive weeks (Monday dates, newest first) ending this week or last week. */
function streakFrom(weeks, thisWeek) {
  const set = new Set(weeks.map((w) => String(w).slice(0, 10)));
  const back = (iso, days) => new Date(Date.parse(`${iso}T12:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  let at = set.has(thisWeek) ? thisWeek : back(thisWeek, 7);
  let n = 0;
  while (set.has(at)) {
    n += 1;
    at = back(at, 7);
  }
  return n;
}

function createIrlStore(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;
  const notify = (userId, actorId, kind, { postId = null, signalId = null, squadId = null, detail = null } = {}) =>
    q("insert into notifications (user_id, actor_id, kind, post_id, signal_id, squad_id, detail) values ($1, $2, $3, $4, $5, $6, $7)", [
      userId, actorId, kind, postId, signalId, squadId, detail,
    ]);
  const col = (target) => (target.kind === "post" ? "post_id" : "signal_id");

  return {
    // ── Pull Up ──────────────────────────────────────────────────────────
    async myPullUp(target, userId) {
      return one(`select * from pull_ups where ${col(target)} = $1 and user_id = $2`, [target.id, userId]);
    },
    /** Who's on the way or pulled up (only people the viewer can see), arrivals first. */
    async pullUps(target, viewerId) {
      return (
        await q(
          `select pu.*, u.username, u.display_name, u.photo_key as avatar_key
             from pull_ups pu join users u on u.id = pu.user_id and u.status = 'active'
            where pu.${col(target)} = $1 and ${canInteract("$2", "pu.user_id")}
            order by (pu.status = 'here') desc, coalesce(pu.arrived_at, pu.created_at) desc limit 60`,
          [target.id, viewerId],
        )
      ).rows;
    },
    /** "On my way" (status 'coming') or "pulled up" ('here'). Tells the owner once per step. */
    async pullUp(target, userId, status) {
      if (String(target.user_id) === String(userId)) throw new InputError("That's yours, so you're already there!");
      const before = await this.myPullUp(target, userId);
      if (status === "coming") {
        if (before) return before;
        const row = await one(`insert into pull_ups (user_id, ${col(target)}, status) values ($1, $2, 'coming') on conflict do nothing returning *`, [userId, target.id]);
        if (row) await notify(target.user_id, userId, "coming", { [target.kind === "post" ? "postId" : "signalId"]: target.id });
        return row;
      }
      if (before && before.status === "here") return before;
      const row = await one(
        `insert into pull_ups (user_id, ${col(target)}, status, arrived_at) values ($1, $2, 'here', now())
           on conflict (${col(target)}, user_id) where ${col(target)} is not null do update set status = 'here', arrived_at = now()
           returning *`,
        [userId, target.id],
      );
      await notify(target.user_id, userId, "pulled_up", { [target.kind === "post" ? "postId" : "signalId"]: target.id });
      return row;
    },
    async cancelPullUp(target, userId) {
      await q(`delete from pull_ups where ${col(target)} = $1 and user_id = $2 and status = 'coming'`, [target.id, userId]);
    },
    /** Saves the arrival selfie; returns the old one's key (to delete). */
    async setPullUpPhoto(target, userId, key) {
      const old = await one(`select photo_key from pull_ups where ${col(target)} = $1 and user_id = $2 and status = 'here'`, [target.id, userId]);
      if (!old) throw new InputError("Pull up first, then add your selfie.");
      await q(`update pull_ups set photo_key = $3 where ${col(target)} = $1 and user_id = $2`, [target.id, userId, key]);
      return old.photo_key;
    },

    // ── Squads ───────────────────────────────────────────────────────────
    async mySquads(userId) {
      return (
        await q(
          `select s.*, m.status as my_status, m.invited_by, inv.username as invited_by_username,
                  (select count(*)::int from squad_members x where x.squad_id = s.id and x.status = 'member') as members,
                  (select array_agg(w.week::text order by w.week desc) from squad_weeks w where w.squad_id = s.id) as weeks
             from squads s join squad_members m on m.squad_id = s.id and m.user_id = $1
             left join users inv on inv.id = m.invited_by
            order by m.status = 'invited' desc, s.created_at desc`,
          [userId],
        )
      ).rows;
    },
    async squadFor(squadId, userId) {
      return one(
        `select s.*, m.status as my_status,
                (select array_agg(w.week::text order by w.week desc) from squad_weeks w where w.squad_id = s.id) as weeks
           from squads s join squad_members m on m.squad_id = s.id and m.user_id = $2 where s.id = $1`,
        [squadId, userId],
      );
    },
    async squadWeek(squadId, week) {
      return one("select * from squad_weeks where squad_id = $1 and week = $2", [squadId, week]);
    },
    async squadMembers(squadId) {
      return (
        await q(
          `select u.id, u.username, u.display_name, u.photo_key, m.status, m.joined_at
             from squad_members m join users u on u.id = m.user_id and u.status = 'active'
            where m.squad_id = $1 order by m.status = 'member' desc, m.joined_at nulls last, u.username`,
          [squadId],
        )
      ).rows;
    },
    async createSquad(userId, { name, emoji }) {
      const title = String(name || "").trim().replace(/\s+/g, " ");
      if (title.length < 2 || title.length > 30) throw new InputError("Give your squad a name (2 to 30 characters).");
      const count = await one("select count(*)::int as n from squad_members where user_id = $1", [userId]);
      if (count.n >= 10) throw new InputError("You're in 10 squads already. Leave one to start another.");
      const squad = await one("insert into squads (name, emoji, created_by) values ($1, $2, $3) returning *", [title, SQUAD_EMOJI.includes(emoji) ? emoji : "🫂", userId]);
      await q("insert into squad_members (squad_id, user_id, status, joined_at) values ($1, $2, 'member', now())", [squad.id, userId]);
      return squad;
    },
    /** Friends who could join: people who follow the inviter and are followed back, not in the squad yet. */
    async squadCandidates(squadId, userId) {
      return (
        await q(
          `select u.id, u.username, u.display_name, u.photo_key
             from follows a join follows b on b.follower_id = a.followee_id and b.followee_id = a.follower_id
             join users u on u.id = a.followee_id and u.status = 'active' and u.username is not null
            where a.follower_id = $1
              and not exists (select 1 from squad_members m where m.squad_id = $2 and m.user_id = u.id)
              and not exists (select 1 from squad_members m where m.squad_id = $2 and not ${canInteract("m.user_id", "u.id")})
            order by u.username limit 200`,
          [userId, squadId],
        )
      ).rows;
    },
    async inviteToSquad(squadId, inviterId, username, { allowed = () => true } = {}) {
      const squad = await this.squadFor(squadId, inviterId);
      if (!squad || squad.my_status !== "member") throw new InputError("Only squad members can invite people.");
      const who = await one("select * from users where username = $1 and status = 'active'", [String(username || "").toLowerCase()]);
      const ok = who && (await this.squadCandidates(squadId, inviterId)).some((c) => String(c.id) === String(who.id)) && allowed(who);
      if (!ok) throw new InputError("You can invite friends who follow you and you follow back.");
      const n = await one("select count(*)::int as n from squad_members where squad_id = $1", [squadId]);
      if (n.n >= SQUAD_MAX) throw new InputError(`A squad can have up to ${SQUAD_MAX} people.`);
      await q("insert into squad_members (squad_id, user_id, status, invited_by) values ($1, $2, 'invited', $3) on conflict do nothing", [squadId, who.id, inviterId]);
      await notify(who.id, inviterId, "squad_invite", { squadId });
      return who;
    },
    async answerSquadInvite(squadId, userId, yes) {
      const row = await one("select * from squad_members where squad_id = $1 and user_id = $2 and status = 'invited'", [squadId, userId]);
      if (!row) return false;
      if (!yes) {
        await q("delete from squad_members where squad_id = $1 and user_id = $2", [squadId, userId]);
        return false;
      }
      await q("update squad_members set status = 'member', joined_at = now() where squad_id = $1 and user_id = $2", [squadId, userId]);
      for (const m of await this.squadMembers(squadId)) {
        if (m.status === "member" && String(m.id) !== String(userId)) await notify(m.id, userId, "squad_join", { squadId });
      }
      return true;
    },
    async leaveSquad(squadId, userId) {
      await q("delete from squad_members where squad_id = $1 and user_id = $2", [squadId, userId]);
      await q("delete from squads where id = $1 and not exists (select 1 from squad_members where squad_id = $1 and status = 'member')", [squadId]);
    },
    /** The person who started the squad can take someone out. */
    async removeFromSquad(squadId, byId, userId) {
      const squad = await one("select * from squads where id = $1", [squadId]);
      if (!squad || String(squad.created_by) !== String(byId) || String(userId) === String(byId)) throw new InputError("Only the person who started the squad can do that.");
      await q("delete from squad_members where squad_id = $1 and user_id = $2", [squadId, userId]);
    },
    async squadMessages(squadId, viewerId, { after = 0 } = {}) {
      return (
        await q(
          `select sm.*, u.username, u.display_name, u.photo_key
             from squad_messages sm join users u on u.id = sm.user_id and u.status = 'active'
            where sm.squad_id = $1 and sm.id > $3 and ${canInteract("$2", "sm.user_id")}
            order by sm.id desc limit 100`,
          [squadId, viewerId, after],
        )
      ).rows.reverse();
    },
    async addSquadMessage(squadId, userId, body) {
      const text = String(body || "").trim();
      if (!text) throw new InputError("Write something first.");
      if (text.length > 1000) throw new InputError("Please keep messages under 1,000 characters.");
      return one("insert into squad_messages (squad_id, user_id, body) values ($1, $2, $3) returning *", [squadId, userId, text]);
    },
    async purgeSquadMessages() {
      await q("delete from squad_messages where created_at < now() - interval '7 days'");
    },

    /**
     * Did this squad do something real together this week (since `weekStart`)?
     * Posts from the same spot within 2 hours, the same plan, pulling up to
     * the same thing (or to a squadmate's post or plan), or the same Moment.
     * Returns the reason, or null.
     */
    async togetherReason(squadId, weekStart) {
      const members = "(select user_id from squad_members where squad_id = $1 and status = 'member')";
      const row = await one(
        `select case
           when exists (
             select 1 from posts a join posts b on b.user_id <> a.user_id
              where a.user_id in ${members} and b.user_id in ${members}
                and a.status = 'visible' and b.status = 'visible' and a.lat is not null and b.lat is not null
                and a.created_at >= $2 and b.created_at >= $2
                and abs(extract(epoch from a.created_at - b.created_at)) <= ${TOGETHER_HOURS * 3600}
                and ${dist("a", "b")} <= ${TOGETHER_MILES}) then 'posted from the same spot'
           when exists (
             select 1 from signals s join signal_joins j1 on j1.signal_id = s.id
              where s.kind = 'plan' and s.plan_at >= $2 and s.plan_at <= now()
                and j1.user_id in ${members}
                and (s.user_id in ${members} and s.user_id <> j1.user_id
                     or exists (select 1 from signal_joins j2 where j2.signal_id = s.id and j2.user_id in ${members} and j2.user_id <> j1.user_id))) then 'went to the same plan'
           when exists (
             select 1 from pull_ups p
               left join posts tp on tp.id = p.post_id left join signals ts on ts.id = p.signal_id
              where p.status = 'here' and p.arrived_at >= $2 and p.user_id in ${members}
                and (coalesce(tp.user_id, ts.user_id) in ${members}
                     or exists (select 1 from pull_ups p2 where p2.status = 'here' and p2.arrived_at >= $2 and p2.user_id in ${members} and p2.user_id <> p.user_id
                                  and (p2.post_id = p.post_id or p2.signal_id = p.signal_id)))) then 'pulled up together'
           when exists (
             select 1 from moment_posts m1 join posts a on a.id = m1.post_id
               join moment_posts m2 on m2.moment_id = m1.moment_id join posts b on b.id = m2.post_id and b.user_id <> a.user_id
              where a.user_id in ${members} and b.user_id in ${members} and a.created_at >= $2) then 'were in the same Moment'
         end as reason`,
        [squadId, weekStart],
      );
      return row.reason;
    },
    /**
     * After someone does something: checks each of their squads, saves a
     * newly together week and tells the squad. Returns [{ squad, streak }].
     */
    async checkTogether(userId, { week, weekStart }) {
      const done = [];
      const squads = (await q("select squad_id from squad_members where user_id = $1 and status = 'member'", [userId])).rows;
      for (const { squad_id: squadId } of squads) {
        if (await one("select 1 from squad_weeks where squad_id = $1 and week = $2", [squadId, week])) continue;
        const reason = await this.togetherReason(squadId, weekStart);
        if (!reason) continue;
        const saved = await one("insert into squad_weeks (squad_id, week, reason) values ($1, $2, $3) on conflict do nothing returning *", [squadId, week, reason]);
        if (!saved) continue;
        const weeks = (await q("select week::text from squad_weeks where squad_id = $1", [squadId])).rows.map((r) => r.week);
        const streak = streakFrom(weeks, week);
        for (const m of await this.squadMembers(squadId)) {
          if (m.status === "member") await notify(m.id, userId, "squad_streak", { squadId, detail: `${streak}|${reason}` });
        }
        done.push({ squadId, streak, reason });
      }
      return done;
    },
    /** Squads with a streak going that haven't done anything this week, not yet reminded. Claims them. */
    async claimStreakReminders(week, lastWeek) {
      const squads = (
        await q(
          `update squads s set reminded_week = $1
            where exists (select 1 from squad_weeks w where w.squad_id = s.id and w.week = $2)
              and not exists (select 1 from squad_weeks w where w.squad_id = s.id and w.week = $1)
              and (s.reminded_week is null or s.reminded_week < $1)
          returning s.*`,
          [week, lastWeek],
        )
      ).rows;
      for (const s of squads) {
        const weeks = (await q("select week::text from squad_weeks where squad_id = $1", [s.id])).rows.map((r) => r.week);
        const streak = streakFrom(weeks, week);
        for (const m of await this.squadMembers(s.id)) {
          if (m.status === "member") await notify(m.id, m.id, "squad_reminder", { squadId: s.id, detail: String(streak) });
        }
      }
      return squads;
    },
  };
}

module.exports = { createIrlStore, streakFrom, SQUAD_EMOJI, SQUAD_MAX };
