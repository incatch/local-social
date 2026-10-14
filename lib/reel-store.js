// Moment Reels (part of the store): which reels exist, and who to tell.

function createReelStore(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;

  return {
    async reelFor(momentId, hash) {
      return one("select * from reels where moment_id = $1 and posts_hash = $2", [momentId, hash]);
    },
    /**
     * Starts making a reel unless one is ready or being made. Returns the row
     * when this caller should make it (so two containers never both do).
     * Failed ones are retried after 30 minutes; stuck ones after 15.
     */
    async claimReel(momentId, hash) {
      return one(
        `insert into reels (moment_id, posts_hash, status) values ($1, $2, 'rendering')
           on conflict (moment_id, posts_hash) do update set status = 'rendering', started_at = now()
           where (reels.status = 'failed' and reels.started_at < now() - interval '30 minutes')
              or (reels.status = 'rendering' and reels.started_at < now() - interval '15 minutes')
         returning *`,
        [momentId, hash],
      );
    },
    async finishReel(id, { videoKey, posterKey }) {
      await q("update reels set status = 'ready', video_key = $2, poster_key = $3, finished_at = now() where id = $1", [id, videoKey, posterKey]);
    },
    async failReel(id) {
      await q("update reels set status = 'failed', finished_at = now() where id = $1", [id]);
    },
    /** Moments that ended 45 minutes to a day ago, with the posters who haven't had their reel yet. */
    async momentsWaitingForReels({ minPosts = 3 } = {}) {
      return (
        await q(
          `select m.id, array_agg(distinct p.user_id) as user_ids
             from moments m join moment_posts mp on mp.moment_id = m.id join posts p on p.id = mp.post_id and p.status = 'visible'
            where m.last_post_at between now() - interval '24 hours' and now() - interval '45 minutes'
              and not exists (select 1 from notifications n where n.kind = 'reel' and n.detail = m.id::text and n.user_id = p.user_id)
            group by m.id
           having (select count(*) from moment_posts x where x.moment_id = m.id) >= $1
            order by m.id limit 10`,
          [minPosts],
        )
      ).rows;
    },
    async notifyReel(userId, momentId) {
      await q(
        `insert into notifications (user_id, actor_id, kind, detail) select $1, $1, 'reel', $2::text
          where not exists (select 1 from notifications where user_id = $1 and kind = 'reel' and detail = $2::text)`,
        [userId, String(momentId)],
      );
    },
  };
}

module.exports = { createReelStore };
