// Blocking, reports and moderation (part of the store).

const { InputError } = require("./errors");

const REASONS = {
  nudity: "Nudity or sexual content",
  minor: "Involves someone under 18",
  harassment: "Bullying or harassment",
  hate: "Hate against a group",
  violence: "Violence or threats",
  self_harm: "Self-harm or suicide",
  spam: "Spam or a scam",
  impersonation: "Pretending to be someone",
  other: "Something else",
};
// Posts reported by this many different people are hidden until reviewed.
const AUTO_HOLD_REPORTS = 3;
// How long an opened snap is kept so it can be reported.
const SNAP_REPORT_MINUTES = 60;

/**
 * SQL: `a` and `b` (column names or $n) can see and reach each other:
 * neither has blocked the other, and they're both adults or both teens
 * (the can_interact function, migrations/006_teens.sql).
 */
const canInteract = (a, b) => `can_interact((${a})::bigint, (${b})::bigint)`;

function createSafetyStore(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;

  return {
    // ── Blocking ─────────────────────────────────────────────────────────
    async block(blockerId, blockedId) {
      if (String(blockerId) === String(blockedId)) throw new InputError("You can't block yourself.");
      await q("insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing", [blockerId, blockedId]);
      // Blocking also ends following, both ways.
      await q("delete from follows where (follower_id = $1 and followee_id = $2) or (follower_id = $2 and followee_id = $1)", [blockerId, blockedId]);
    },
    async unblock(blockerId, blockedId) {
      await q("delete from blocks where blocker_id = $1 and blocked_id = $2", [blockerId, blockedId]);
    },
    /** Can these two people see and reach each other? (No block, and both adults or both teens.) */
    async canInteract(a, b) {
      return (await one("select can_interact($1::bigint, $2::bigint) as ok", [a, b])).ok;
    },
    /** 'me' if a blocked b, 'them' if b blocked a, or null. */
    async blockBetween(a, b) {
      const row = await one("select blocker_id from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1) limit 1", [a, b]);
      if (!row) return null;
      return String(row.blocker_id) === String(a) ? "me" : "them";
    },
    async blockedList(userId) {
      return (
        await q(
          `select u.id, u.username, u.display_name, u.photo_key from blocks b join users u on u.id = b.blocked_id
            where b.blocker_id = $1 order by b.created_at desc`,
          [userId],
        )
      ).rows;
    },

    // ── Reports ──────────────────────────────────────────────────────────
    /**
     * A report. `target` is { type, userId, postId, commentId, messageId,
     * snapshotText, snapshotKey }. Returns { report, held } where held means
     * the post was hidden because enough people reported it.
     */
    async report(reporterId, target, { reason, details }) {
      if (!REASONS[reason]) throw new InputError("Please pick a reason.");
      const report = await one(
        `insert into reports (reporter_id, target_type, user_id, post_id, comment_id, message_id, snapshot_text, snapshot_key, reason, details)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict do nothing returning *`,
        [
          reporterId,
          target.type,
          target.userId,
          target.postId || null,
          target.commentId || null,
          target.messageId || null,
          target.snapshotText || null,
          target.snapshotKey || null,
          reason,
          String(details || "").trim().slice(0, 1000),
        ],
      );
      let held = false;
      if (report && target.type === "post") {
        const n = await one("select count(distinct reporter_id)::int as n from reports where post_id = $1 and status = 'open'", [target.postId]);
        if (n.n >= AUTO_HOLD_REPORTS || reason === "minor") {
          held = (await q("update posts set status = 'held' where id = $1 and status = 'visible'", [target.postId])).rowCount > 0;
        }
      }
      if (report && target.type === "comment" && reason === "minor") {
        await q("update comments set status = 'held' where id = $1 and status = 'visible'", [target.commentId]);
      }
      return { report, held };
    },

    // ── The owner's moderation queue ─────────────────────────────────────
    /** Open reports (newest first), with who and what they're about. */
    async openReports() {
      return (
        await q(
          `select r.*, rep.username as reporter_username, u.username as target_username, u.status as target_status, is_teen(r.user_id) as target_teen,
                  p.caption as post_caption, p.status as post_status,
                  (select array_agg(photo_key order by position) from post_photos pp where pp.post_id = r.post_id) as post_photos,
                  c.body as comment_body
             from reports r
             left join users rep on rep.id = r.reporter_id
             left join users u on u.id = r.user_id
             left join posts p on p.id = r.post_id
             left join comments c on c.id = r.comment_id
            where r.status = 'open'
            order by (r.reason = 'minor') desc, r.created_at desc limit 200`,
        )
      ).rows;
    },
    /** Posts held for review (by screening or reports). */
    async heldPosts() {
      return (
        await q(
          `select p.*, u.username, is_teen(p.user_id) as target_teen, (select array_agg(photo_key order by position) from post_photos pp where pp.post_id = p.id) as photo_keys,
                  (select count(*)::int from reports r where r.post_id = p.id and r.status = 'open') as open_reports
             from posts p join users u on u.id = p.user_id where p.status = 'held' order by p.created_at desc limit 200`,
        )
      ).rows;
    },
    async moderationCounts() {
      return one(
        `select (select count(*)::int from reports where status = 'open') as reports,
                (select count(*)::int from reports where status = 'open' and reason = 'minor') as minor,
                (select count(*)::int from posts where status = 'held') as held`,
      );
    },
    async resolveReports(where, resolution) {
      const [column, id] = where;
      await q(`update reports set status = 'resolved', resolution = $2, resolved_at = now() where ${column} = $1 and status = 'open'`, [id, resolution]);
    },
    async resolveReport(id, resolution) {
      return one("update reports set status = 'resolved', resolution = $2, resolved_at = now() where id = $1 and status = 'open' returning *", [id, resolution]);
    },
    async report1(id) {
      return one("select * from reports where id = $1", [id]);
    },
    /** The reasons people gave for reports about one thing (for the store). */
    async reasonsFor(column, id) {
      const { rows } = await q(`select distinct reason from reports where ${column} = $1`, [id]);
      return rows.map((r) => r.reason);
    },

    async setPostStatus(postId, status) {
      return one("update posts set status = $2 where id = $1 returning *", [postId, status]);
    },
    async setCommentStatus(commentId, status) {
      const comment = await one("update comments set status = $2 where id = $1 returning *", [commentId, status]);
      if (comment) {
        await q("update posts set comment_count = (select count(*) from comments where post_id = $1 and status = 'visible') where id = $1", [comment.post_id]);
      }
      return comment;
    },
    async postForModeration(postId) {
      return one(
        `select p.*, u.username, (select array_agg(photo_key order by position) from post_photos pp where pp.post_id = p.id) as photo_keys,
                (select array_agg(thumb_key order by position) from post_photos pp where pp.post_id = p.id) as thumb_keys
           from posts p join users u on u.id = p.user_id where p.id = $1`,
        [postId],
      );
    },
    async commentForModeration(commentId) {
      return one("select c.*, u.username from comments c join users u on u.id = c.user_id where c.id = $1", [commentId]);
    },

    // ── The moderated-out store ──────────────────────────────────────────
    async addModerated(item) {
      return one(
        `insert into moderated_items (source, user_id, username, body, media_keys, labels, report_reasons, decision, training_ok, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [
          item.source,
          item.userId || null,
          item.username || null,
          item.body || "",
          item.mediaKeys || [],
          item.labels ? JSON.stringify(item.labels) : null,
          item.reasons || [],
          item.decision,
          item.decision !== "legal_hold" && !(item.reasons || []).includes("minor"),
          item.note || "",
        ],
      );
    },
    async moderatedItems({ decision = null, limit = 100 } = {}) {
      return (
        await q("select * from moderated_items where ($1::text is null or decision = $1) order by created_at desc limit $2", [decision, limit])
      ).rows;
    },
    async moderatedItem(id) {
      return one("select * from moderated_items where id = $1", [id]);
    },
    /** Is this media key in the store (and not under legal hold)? Admin viewing only. */
    async moderatedKeyViewable(key) {
      const row = await one("select 1 from moderated_items where $1 = any(media_keys) and decision <> 'legal_hold' limit 1", [key]);
      const report = await one("select 1 from reports where snapshot_key = $1 and reason <> 'minor' limit 1", [key]);
      return Boolean(row || report);
    },

    // ── Snaps kept briefly after opening, so they can be reported ────────
    async keepOpenedSnap(messageId, key) {
      await q("update messages set report_key = $2, report_until = now() + make_interval(mins => $3) where id = $1", [messageId, key, SNAP_REPORT_MINUTES]);
    },
    /** Deletes opened snaps whose report window is over. Returns keys to remove. */
    async purgeSnapWindows(now = new Date()) {
      const { rows } = await q(
        "update messages m set report_key = null, report_until = null from messages old where m.id = old.id and m.report_until < $1 returning old.report_key",
        [now],
      );
      return rows.map((r) => r.report_key).filter(Boolean);
    },
  };
}

module.exports = { createSafetyStore, canInteract, REASONS, AUTO_HOLD_REPORTS, SNAP_REPORT_MINUTES };
