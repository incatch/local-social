// Posts, likes, comments, follows and the feeds (part of the store).

const { InputError } = require("./errors");
const { canInteract } = require("./safety-store");

const MAX_CAPTION = 2200;
const MAX_COMMENT = 1000;
const MAX_PHOTOS = 10;
const PAGE_SIZE = 20;
const MENTION = /(^|[^a-z0-9_.@])@([a-z0-9_.]{3,30})/gi;

/** The @usernames in some text (lowercase, no duplicates). */
function mentionedUsernames(text) {
  const names = new Set();
  for (const m of String(text || "").matchAll(MENTION)) names.add(m[2].toLowerCase().replace(/\.+$/, ""));
  return [...names];
}

function checkCaption(value) {
  const caption = String(value || "").trim().replace(/\r\n/g, "\n");
  if (caption.length > MAX_CAPTION) throw new InputError(`Captions can be up to ${MAX_CAPTION} characters.`);
  return caption;
}

// Visible posts, plus the viewer's ($1) own posts waiting for review.
const SEEN = `(p.status = 'visible' or (p.status = 'held' and p.user_id = $1)) and ${canInteract("$1", "p.user_id")}`;

// The columns every list of posts needs: the post, its author, and whether
// the viewer ($1) liked it.
const POST_COLUMNS = `p.*, u.username, u.display_name, u.photo_key as author_photo_key,
  exists (select 1 from likes l where l.post_id = p.id and l.user_id = $1) as liked`;

function createPostStore(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;

  /** Adds each post's photos (in order) as `photos`. */
  async function withPhotos(posts) {
    if (!posts.length) return posts;
    const { rows } = await q("select * from post_photos where post_id = any($1) order by post_id, position", [posts.map((p) => p.id)]);
    const byPost = new Map(posts.map((p) => [String(p.id), (p.photos = [])]));
    for (const r of rows) byPost.get(String(r.post_id))?.push(r);
    return posts;
  }

  async function recordMentions(db, byUserId, text, { postId = null, commentId = null }) {
    const names = mentionedUsernames(text);
    if (!names.length) return;
    await db.query(
      `insert into mentions (user_id, by_user_id, post_id, comment_id)
       select id, $2, $3, $4 from users where username = any($1) and id <> $2 and status = 'active'`,
      [names, byUserId, postId, commentId],
    );
    // Tell them (once per post or comment, so editing a caption doesn't repeat it).
    await db.query(
      `insert into notifications (user_id, actor_id, kind, post_id, comment_id)
       select id, $2, 'mention', $3, $4 from users u where username = any($1) and id <> $2 and status = 'active'
          and not exists (select 1 from notifications n where n.user_id = u.id and n.kind = 'mention'
                          and n.post_id is not distinct from $3 and n.comment_id is not distinct from $4)`,
      [names, byUserId, postId, commentId],
    );
  }

  return {
    // ── Posts ────────────────────────────────────────────────────────────
    /**
     * A new post. `photos` are [{ photoKey, thumbKey, width, height }] (already
     * stored); `place` is the rounded location (or null) and `areaName` its town.
     */
    async createPost(userId, { caption, photos, place, areaName, held = false, labels = null }) {
      caption = checkCaption(caption);
      if (!photos.length) throw new InputError("Please add at least one photo.");
      if (photos.length > MAX_PHOTOS) throw new InputError(`Up to ${MAX_PHOTOS} photos per post.`);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const {
          rows: [post],
        } = await client.query(
          "insert into posts (user_id, caption, lat, lon, area_name, status, screen_labels) values ($1, $2, $3, $4, $5, $6, $7) returning *",
          [userId, caption, place?.lat ?? null, place?.lon ?? null, place ? areaName : null, held ? "held" : "visible", labels && labels.length ? JSON.stringify(labels) : null],
        );
        for (const [i, photo] of photos.entries()) {
          await client.query("insert into post_photos (post_id, position, photo_key, thumb_key, width, height) values ($1, $2, $3, $4, $5, $6)", [
            post.id,
            i,
            photo.photoKey,
            photo.thumbKey,
            photo.width,
            photo.height,
          ]);
        }
        await recordMentions(client, userId, caption, { postId: post.id });
        await client.query("commit");
        return post;
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },

    /** One visible post (with photos), as seen by `viewerId`; null if gone. */
    async post(postId, viewerId) {
      if (!/^\d{1,18}$/.test(String(postId))) return null;
      const post = await one(
        `select ${POST_COLUMNS} from posts p join users u on u.id = p.user_id
          where p.id = $2 and ${SEEN} and u.status = 'active'`,
        [viewerId, postId],
      );
      return post ? (await withPhotos([post]))[0] : null;
    },

    async updateCaption(postId, userId, caption) {
      caption = checkCaption(caption);
      const post = await one("update posts set caption = $3, edited_at = now() where id = $1 and user_id = $2 returning *", [postId, userId, caption]);
      if (!post) throw new InputError("You can only edit your own posts.");
      await q("delete from mentions where post_id = $1", [postId]);
      await recordMentions(pool, userId, caption, { postId });
    },

    /** Deletes the viewer's own post; returns its photo keys (to remove from storage). */
    async deletePost(postId, userId) {
      const { rows } = await q(
        `delete from post_photos where post_id = (select id from posts where id = $1 and user_id = $2) returning photo_key, thumb_key`,
        [postId, userId],
      );
      const post = await one("delete from posts where id = $1 and user_id = $2 returning id", [postId, userId]);
      if (!post) throw new InputError("You can only delete your own posts.");
      return rows.flatMap((r) => [r.photo_key, r.thumb_key]);
    },

    // ── Likes ────────────────────────────────────────────────────────────
    /** Likes or unlikes; returns { liked, count }. */
    async toggleLike(postId, userId) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const {
          rows: [post],
        } = await client.query("select id, user_id from posts where id = $1 and status = 'visible' for update", [postId]);
        if (!post) throw new InputError("That post isn't there any more.");
        const removed = await client.query("delete from likes where post_id = $1 and user_id = $2", [postId, userId]);
        if (removed.rowCount) {
          await client.query("delete from notifications where kind = 'like' and post_id = $1 and actor_id = $2", [postId, userId]);
        } else {
          await client.query("insert into likes (post_id, user_id) values ($1, $2)", [postId, userId]);
          if (String(post.user_id) !== String(userId)) {
            await client.query("insert into notifications (user_id, actor_id, kind, post_id) values ($1, $2, 'like', $3)", [post.user_id, userId, postId]);
          }
        }
        const {
          rows: [counted],
        } = await client.query(
          "update posts set like_count = (select count(*) from likes where post_id = $1) where id = $1 returning like_count",
          [postId],
        );
        await client.query("commit");
        return { liked: !removed.rowCount, count: counted.like_count };
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },

    // ── Comments ─────────────────────────────────────────────────────────
    async comments(postId, viewerId) {
      return (
        await q(
          `select c.*, u.username, u.display_name, u.photo_key as author_photo_key
             from comments c join users u on u.id = c.user_id
            where c.post_id = $1 and c.status = 'visible' and u.status = 'active' and ${canInteract("$2", "c.user_id")}
            order by c.created_at, c.id`,
          [postId, viewerId],
        )
      ).rows;
    },
    async addComment(postId, userId, body) {
      body = String(body || "").trim().replace(/\r\n/g, "\n");
      if (!body) throw new InputError("Please write a comment.");
      if (body.length > MAX_COMMENT) throw new InputError(`Comments can be up to ${MAX_COMMENT} characters.`);
      const post = await one(`select id, user_id from posts p where id = $1 and status = 'visible' and ${canInteract("$2", "p.user_id")}`, [postId, userId]);
      if (!post) throw new InputError("That post isn't there any more.");
      const comment = await one("insert into comments (post_id, user_id, body) values ($1, $2, $3) returning *", [postId, userId, body]);
      if (String(post.user_id) !== String(userId)) {
        await q("insert into notifications (user_id, actor_id, kind, post_id, comment_id) values ($1, $2, 'comment', $3, $4)", [post.user_id, userId, postId, comment.id]);
      }
      await q("update posts set comment_count = comment_count + 1 where id = $1", [postId]);
      await recordMentions(pool, userId, body, { postId, commentId: comment.id });
      return comment;
    },
    /** Deletes a comment: your own, or anyone's on your post. */
    async deleteComment(commentId, userId) {
      const comment = await one(
        `delete from comments c using posts p
          where c.id = $1 and p.id = c.post_id and (c.user_id = $2 or p.user_id = $2)
          returning c.post_id, c.status`,
        [commentId, userId],
      );
      if (!comment) throw new InputError("You can only delete your own comments, or comments on your posts.");
      if (comment.status === "visible") await q("update posts set comment_count = greatest(comment_count - 1, 0) where id = $1", [comment.post_id]);
      return comment.post_id;
    },

    // ── Follows ──────────────────────────────────────────────────────────
    /** Follows or unfollows; returns whether `followerId` now follows. */
    async toggleFollow(followerId, followeeId) {
      if (String(followerId) === String(followeeId)) throw new InputError("You can't follow yourself.");
      const blocked = await one(`select 1 where not ${canInteract("$1::bigint", "$2::bigint")}`, [followerId, followeeId]);
      if (blocked) throw new InputError("You can't follow this person.");
      const removed = await q("delete from follows where follower_id = $1 and followee_id = $2", [followerId, followeeId]);
      if (removed.rowCount) {
        await q("delete from notifications where kind = 'follow' and user_id = $1 and actor_id = $2", [followeeId, followerId]);
        return false;
      }
      const added = await q("insert into follows (follower_id, followee_id) values ($1, $2) on conflict do nothing", [followerId, followeeId]);
      if (added.rowCount) await q("insert into notifications (user_id, actor_id, kind) values ($1, $2, 'follow')", [followeeId, followerId]);
      return true;
    },
    /** Do these two follow each other? */
    async mutualFollow(a, b) {
      const row = await one(
        "select (select count(*) from follows where (follower_id = $1 and followee_id = $2) or (follower_id = $2 and followee_id = $1))::int as n",
        [a, b],
      );
      return row.n === 2;
    },
    /** Does `follower` follow `followee`? */
    async follows(follower, followee) {
      return Boolean(await one("select 1 from follows where follower_id = $1 and followee_id = $2", [follower, followee]));
    },
    async followStats(userId, viewerId) {
      return one(
        `select (select count(*)::int from follows where followee_id = $1) as followers,
                (select count(*)::int from follows where follower_id = $1) as following,
                (select count(*)::int from posts where user_id = $1 and status = 'visible') as posts,
                exists (select 1 from follows where follower_id = $2 and followee_id = $1) as followed`,
        [userId, viewerId],
      );
    },

    // ── Feeds ────────────────────────────────────────────────────────────
    async setFeedLocation(userId, place) {
      await q("update users set feed_lat = $2, feed_lon = $3 where id = $1", [userId, place.lat, place.lon]);
    },
    async setFeedRadius(userId, miles, { min = 0 } = {}) {
      const radius = Number(miles);
      if (![5, 10, 25, 50].includes(radius) || radius < min) throw new InputError(`Pick ${[5, 10, 25, 50].filter((m) => m >= min).join(", ")} miles.`);
      await q("update users set feed_radius_miles = $2 where id = $1", [userId, radius]);
    },

    /**
     * Posts within the viewer's radius of their latest location: newest first,
     * with a light boost for likes (each doubling of likes counts like a post
     * about 4 hours newer).
     */
    async nearbyFeed(viewer, { page = 0 } = {}) {
      if (viewer.feed_lat === null || viewer.feed_lat === undefined) return [];
      const posts = (
        await q(
          `select ${POST_COLUMNS}
             from posts p join users u on u.id = p.user_id
            where p.status = 'visible' and u.status = 'active' and p.lat is not null and ${canInteract("$1", "p.user_id")}
              and p.lat between $2 - $4 / 69.0 and $2 + $4 / 69.0
              and p.lon between $3 - $4 / (69.0 * cos(radians($2))) and $3 + $4 / (69.0 * cos(radians($2)))
              and 3958.8 * 2 * asin(sqrt(power(sin(radians(p.lat - $2) / 2), 2)
                    + cos(radians($2)) * cos(radians(p.lat)) * power(sin(radians(p.lon - $3) / 2), 2))) <= $4
            order by extract(epoch from p.created_at) + 20000 * log(2, 1 + p.like_count) desc, p.id desc
            limit $5 offset $6`,
          [viewer.id, viewer.feed_lat, viewer.feed_lon, Math.max(viewer.feed_radius_miles, viewer.min_radius || 0), PAGE_SIZE + 1, page * PAGE_SIZE],
        )
      ).rows;
      return withPhotos(posts);
    },

    /** Posts from people the viewer follows (and their own), newest first. */
    async followingFeed(viewer, { page = 0 } = {}) {
      const posts = (
        await q(
          `select ${POST_COLUMNS}
             from posts p join users u on u.id = p.user_id
            where ${SEEN} and u.status = 'active'
              and (p.user_id = $1 or p.user_id in (select followee_id from follows where follower_id = $1))
            order by p.created_at desc, p.id desc
            limit $2 offset $3`,
          [viewer.id, PAGE_SIZE + 1, page * PAGE_SIZE],
        )
      ).rows;
      return withPhotos(posts);
    },

    /** A profile's posts, newest first (with photos, for the grid). */
    async profilePosts(userId, viewerId, { page = 0 } = {}) {
      const posts = (
        await q(
          `select ${POST_COLUMNS} from posts p join users u on u.id = p.user_id
            where p.user_id = $2 and ${SEEN}
            order by p.created_at desc, p.id desc limit $3 offset $4`,
          [viewerId, userId, PAGE_SIZE * 3 + 1, page * PAGE_SIZE * 3],
        )
      ).rows;
      return withPhotos(posts);
    },
  };
}

module.exports = { createPostStore, mentionedUsernames, PAGE_SIZE, MAX_PHOTOS };
