// Messages, snaps and notifications (part of the store).
//
// The rules:
// - A first message to someone who doesn't follow you is a message request.
//   Until they accept (or reply), you can send up to REQUEST_LIMIT text
//   messages and no snaps.
// - Read messages are deleted READ_HOURS after they're read, unless both
//   people keep the chat. Unread ones are deleted after UNREAD_DAYS.
// - Snaps open once: the photo is deleted as it's shown.

const { InputError } = require("./errors");
const { canInteract } = require("./safety-store");

const MAX_MESSAGE = 1000;
const REQUEST_LIMIT = 3;
const NEW_CHATS_PER_DAY = 20;
const READ_HOURS = 24;
const UNREAD_DAYS = 30;
const MESSAGE_PAGE = 100;
const ACTIVITY_PAGE = 50;

/** The two people in a conversation, in the order the table keeps them. */
const pair = (x, y) => (Number(x) < Number(y) ? [x, y] : [y, x]);

function createMessageStore(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;

  // A conversation as `viewerId` sees it: the other person, and whether each keeps it.
  const COLUMNS = `c.*, o.id as other_id, o.username as other_username, o.display_name as other_display_name,
      o.photo_key as other_photo_key, o.status as other_status,
      case when c.user_a = $1 then c.a_keeps else c.b_keeps end as i_keep,
      case when c.user_a = $1 then c.b_keeps else c.a_keeps end as they_keep`;
  const FROM = "from conversations c join users o on o.id = case when c.user_a = $1 then c.user_b else c.user_a end";

  async function addMessage(conversation, senderId, { kind, body = "", photoKey = null }) {
    const message = await one(
      "insert into messages (conversation_id, sender_id, kind, body, photo_key) values ($1, $2, $3, $4, $5) returning *",
      [conversation.id, senderId, kind, body, photoKey],
    );
    await q("update conversations set last_message_at = now() where id = $1", [conversation.id]);
    return message;
  }

  return {
    // ── Conversations ────────────────────────────────────────────────────
    /** The conversation between two people (made if needed); null if it's yourself. */
    async conversationWith(userId, otherId) {
      if (String(userId) === String(otherId)) throw new InputError("You can't message yourself.");
      const blocked = await one(`select 1 where not ${canInteract("$1::bigint", "$2::bigint")}`, [userId, otherId]);
      if (blocked) throw new InputError("You can't message this person.");
      const [a, b] = pair(userId, otherId);
      const found = await one("select id from conversations where user_a = $1 and user_b = $2", [a, b]);
      if (found) return found.id;
      const today = await one("select count(*)::int as n from conversations where started_by = $1 and created_at > now() - interval '1 day'", [userId]);
      if (today.n >= NEW_CHATS_PER_DAY) throw new InputError("You've started a lot of new chats today. Please try again tomorrow.");
      // People they follow can message them straight away.
      const follows = await one("select 1 from follows where follower_id = $1 and followee_id = $2", [otherId, userId]);
      const made = await one(
        `insert into conversations (user_a, user_b, started_by, accepted_at) values ($1, $2, $3, $4)
         on conflict (user_a, user_b) do update set user_a = excluded.user_a returning id`,
        [a, b, userId, follows ? new Date() : null],
      );
      return made.id;
    },

    /** One conversation `viewerId` is in (null if not theirs). */
    async conversation(id, viewerId) {
      if (!/^\d{1,18}$/.test(String(id))) return null;
      const c = await one(`select ${COLUMNS} ${FROM} where c.id = $2 and $1 in (c.user_a, c.user_b)`, [viewerId, id]);
      if (!c) return null;
      c.blocked = Boolean(await one(`select 1 where not ${canInteract("$1::bigint", "$2::bigint")}`, [viewerId, c.other_id]));
      c.is_request = !c.accepted_at;
      c.request_to_me = c.is_request && String(c.started_by) !== String(viewerId);
      return c;
    },

    /**
     * The inbox: chats (accepted, or requests you sent), or `requests`
     * waiting for you. Each has the latest message and how many are unread.
     */
    async inbox(viewerId, { requests = false } = {}) {
      const { rows } = await q(
        `select ${COLUMNS},
           (select count(*)::int from messages m where m.conversation_id = c.id and m.sender_id <> $1 and m.read_at is null) as unread,
           last.kind as last_kind, last.body as last_body, last.sender_id as last_sender_id, last.read_at as last_read_at
         ${FROM}
         left join lateral (select * from messages m where m.conversation_id = c.id order by m.id desc limit 1) last on true
         where $1 in (c.user_a, c.user_b) and o.status = 'active' and ${canInteract("$1", "o.id")}
           and ${requests ? "c.accepted_at is null and c.started_by <> $1" : "(c.accepted_at is not null or c.started_by = $1)"}
           ${requests ? "and last.id is not null" : ""}
         order by c.last_message_at desc limit 200`,
        [viewerId],
      );
      return rows;
    },

    /** Counts for the badges: chats with unread messages, and requests waiting. */
    async messageCounts(viewerId) {
      return one(
        `select count(*) filter (where c.accepted_at is not null or c.started_by = $1)::int as unread,
                count(*) filter (where c.accepted_at is null and c.started_by <> $1)::int as requests
           from conversations c
          where $1 in (c.user_a, c.user_b)
            and ${canInteract("$1", "case when c.user_a = $1 then c.user_b else c.user_a end")}
            and exists (select 1 from messages m where m.conversation_id = c.id and m.sender_id <> $1 and m.read_at is null)`,
        [viewerId],
      );
    },

    async acceptRequest(conversation, viewerId) {
      if (!conversation.request_to_me) return;
      await q("update conversations set accepted_at = now() where id = $1 and accepted_at is null", [conversation.id]);
    },

    /** Deletes a conversation (declining a request). Returns snap photo keys to remove. */
    async deleteConversation(conversation) {
      const { rows } = await q("select photo_key, report_key from messages where conversation_id = $1", [conversation.id]);
      await q("delete from conversations where id = $1", [conversation.id]);
      return rows.flatMap((r) => [r.photo_key, r.report_key]).filter(Boolean);
    },

    async setKeep(conversation, viewerId, keep) {
      const column = String(conversation.user_a) === String(viewerId) ? "a_keeps" : "b_keeps";
      await q(`update conversations set ${column} = $2 where id = $1`, [conversation.id, Boolean(keep)]);
    },

    // ── Messages ─────────────────────────────────────────────────────────
    /** The messages in a conversation (oldest first), optionally only those after `afterId`. */
    async messages(conversation, { afterId = 0 } = {}) {
      const { rows } = await q(
        `select * from (select * from messages where conversation_id = $1 and id > $2 order by id desc limit $3) m order by id`,
        [conversation.id, Number(afterId) || 0, MESSAGE_PAGE],
      );
      return rows;
    },

    /** Marks the other person's text messages as read (snaps are read when opened). */
    async markRead(conversation, viewerId) {
      await q("update messages set read_at = now() where conversation_id = $1 and sender_id <> $2 and read_at is null and kind = 'text'", [
        conversation.id,
        viewerId,
      ]);
    },

    /** Checks the sender may send this now (request limits); replying accepts a request. */
    async checkCanSend(conversation, senderId, kind) {
      if (conversation.other_status !== "active") throw new InputError("This person's account is closed.");
      if (conversation.blocked) throw new InputError("You can't message this person.");
      if (conversation.request_to_me) {
        await q("update conversations set accepted_at = now() where id = $1 and accepted_at is null", [conversation.id]);
        conversation.is_request = conversation.request_to_me = false;
        return;
      }
      if (!conversation.is_request) return;
      if (kind === "snap") throw new InputError("You can send photos once they've accepted your message request.");
      const sent = await one("select count(*)::int as n from messages where conversation_id = $1 and sender_id = $2", [conversation.id, senderId]);
      if (sent.n >= REQUEST_LIMIT) throw new InputError(`You can send up to ${REQUEST_LIMIT} messages until they accept your request.`);
    },

    async sendText(conversation, senderId, body) {
      body = String(body || "").trim().replace(/\r\n/g, "\n");
      if (!body) throw new InputError("Please write a message.");
      if (body.length > MAX_MESSAGE) throw new InputError(`Messages can be up to ${MAX_MESSAGE} characters.`);
      return addMessage(conversation, senderId, { kind: "text", body });
    },

    async sendSnap(conversation, senderId, photoKey) {
      return addMessage(conversation, senderId, { kind: "snap", photoKey });
    },

    /**
     * Opens a snap sent to `viewerId`: returns its photo key (once) and marks it
     * opened; the caller shows the photo and then deletes it.
     */
    async openSnap(conversation, messageId, viewerId) {
      if (!/^\d{1,18}$/.test(String(messageId))) return null;
      const snap = await one(
        `update messages m set read_at = now(), photo_key = null
           from messages before
          where m.id = before.id and m.id = $1 and m.conversation_id = $2 and m.kind = 'snap' and m.sender_id <> $3 and m.photo_key is not null
          returning before.photo_key`,
        [messageId, conversation.id, viewerId],
      );
      return snap?.photo_key || null;
    },

    /** One message in a conversation (for reporting). */
    async message(conversation, messageId) {
      if (!/^\d{1,18}$/.test(String(messageId))) return null;
      return one("select * from messages where id = $1 and conversation_id = $2", [messageId, conversation.id]);
    },

    /** Deletes your own message ("unsend"). Returns its snap photo key, if any. */
    async unsend(conversation, messageId, senderId) {
      if (!/^\d{1,18}$/.test(String(messageId))) throw new InputError("That message isn't there any more.");
      const gone = await one("delete from messages where id = $1 and conversation_id = $2 and sender_id = $3 returning photo_key, report_key", [
        messageId,
        conversation.id,
        senderId,
      ]);
      if (!gone) throw new InputError("You can only unsend your own messages.");
      return [gone.photo_key, gone.report_key].filter(Boolean);
    },

    /**
     * Deletes messages whose time is up: read more than READ_HOURS ago (unless
     * both people keep the chat), or never read after UNREAD_DAYS. Returns the
     * snap photo keys to remove from storage.
     */
    async purgeMessages(now = new Date()) {
      const { rows } = await q(
        `delete from messages m using conversations c
          where c.id = m.conversation_id
            and ((m.read_at is not null and m.read_at < $1::timestamptz - make_interval(hours => $2) and not (c.a_keeps and c.b_keeps))
              or (m.read_at is null and m.created_at < $1::timestamptz - make_interval(days => $3)))
          returning m.photo_key, m.report_key`,
        [now, READ_HOURS, UNREAD_DAYS],
      );
      return rows.flatMap((r) => [r.photo_key, r.report_key]).filter(Boolean);
    },

    // ── Notifications ────────────────────────────────────────────────────
    /** The Activity page: newest first, with who did it and a thumbnail of the post. */
    async activity(viewerId) {
      const { rows } = await q(
        `select n.*, a.username as actor_username, a.display_name as actor_display_name, a.photo_key as actor_photo_key,
                (select thumb_key from post_photos pp where pp.post_id = n.post_id order by position limit 1) as thumb_key,
                c.body as comment_body, mo.title as moment_title, sg.body as signal_body, sg.kind as signal_kind, sq.name as squad_name, dr.place_name as drop_place,
                exists (select 1 from follows f where f.follower_id = $1 and f.followee_id = n.actor_id) as following_back
           from notifications n
           join users a on a.id = n.actor_id and a.status = 'active'
           left join posts p on p.id = n.post_id
           left join comments c on c.id = n.comment_id
           left join moments mo on n.kind = 'moment' and mo.id::text = n.detail
           left join signals sg on sg.id = n.signal_id
           left join squads sq on sq.id = n.squad_id
           left join drops dr on dr.id = n.drop_id
          where n.user_id = $1 and ${canInteract("$1", "n.actor_id")} and (n.signal_id is null or sg.status = 'visible') and (n.post_id is null or p.status = 'visible') and (n.comment_id is null or c.status = 'visible')
          order by n.created_at desc, n.id desc limit $2`,
        [viewerId, ACTIVITY_PAGE],
      );
      return rows;
    },
    async unseenActivity(viewerId) {
      const row = await one(
        `select count(*)::int as n from notifications n join users u on u.id = n.user_id
          where n.user_id = $1 and n.created_at > u.activity_seen_at and ${canInteract("$1", "n.actor_id")}`,
        [viewerId],
      );
      return row.n;
    },
    async markActivitySeen(viewerId) {
      await q("update users set activity_seen_at = now() where id = $1", [viewerId]);
    },
  };
}

module.exports = { createMessageStore, REQUEST_LIMIT, READ_HOURS, UNREAD_DAYS, MAX_MESSAGE };
