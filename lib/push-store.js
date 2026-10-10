// Phone notifications (part of the store): who has them on, and which
// notifications and messages still need sending.

const { InputError } = require("./errors");
const { canInteract } = require("./safety-store");

function createPushStore(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;

  return {
    async addPushSubscription(userId, { endpoint, p256dh, auth, device = "" }) {
      const url = String(endpoint || "");
      if (!/^https:\/\/[^\s]{10,2000}$/.test(url) || !/^[A-Za-z0-9_-]{20,200}$/.test(String(p256dh || "")) || !/^[A-Za-z0-9_-]{8,100}$/.test(String(auth || ""))) {
        throw new InputError("Your browser sent something we didn't understand. Please try again.");
      }
      // A device belongs to whoever turned notifications on there last.
      await q(
        `insert into push_subscriptions (user_id, endpoint, p256dh, auth, device) values ($1, $2, $3, $4, $5)
           on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`,
        [userId, url, p256dh, auth, String(device).slice(0, 300)],
      );
    },
    async removePushSubscription(userId, endpoint) {
      await q("delete from push_subscriptions where user_id = $1 and endpoint = $2", [userId, String(endpoint || "")]);
    },
    async dropPushSubscription(id) {
      await q("delete from push_subscriptions where id = $1", [id]);
    },
    async pushSubscriptions(userId) {
      return (await q("select * from push_subscriptions where user_id = $1 order by id", [userId])).rows;
    },
    async pushSent(id) {
      await q("update push_subscriptions set last_sent_at = now() where id = $1", [id]);
    },
    async pushDeviceCount(userId) {
      return (await one("select count(*)::int as n from push_subscriptions where user_id = $1", [userId])).n;
    },

    /** New notifications to send to phones (claimed, so each is sent once). */
    async claimPushNotifications(limit = 200) {
      return (
        await q(
          `with claimed as (
             update notifications set pushed_at = now()
              where id in (select id from notifications where pushed_at is null order by id limit $1 for update skip locked)
             returning *)
           select n.*, a.username as actor_username, a.display_name as actor_display_name,
                  c.body as comment_body, mo.title as moment_title, sg.kind as signal_kind, sq.name as squad_name
             from claimed n
             join users a on a.id = n.actor_id and a.status = 'active'
             left join comments c on c.id = n.comment_id
             left join moments mo on n.kind = 'moment' and mo.id::text = n.detail
             left join signals sg on sg.id = n.signal_id
             left join squads sq on sq.id = n.squad_id
            where n.created_at > now() - interval '15 minutes'
              and ${canInteract("n.user_id", "n.actor_id")}
              and exists (select 1 from push_subscriptions s where s.user_id = n.user_id)
            order by n.id`,
          [limit],
        )
      ).rows;
    },
    /** New messages to send to phones: who it's to, who from, and whether it's a request. */
    async claimPushMessages(limit = 200) {
      return (
        await q(
          `with claimed as (
             update messages set pushed_at = now()
              where id in (select id from messages where pushed_at is null order by id limit $1 for update skip locked)
             returning *)
           select m.id, m.kind, m.conversation_id, m.created_at,
                  case when c.user_a = m.sender_id then c.user_b else c.user_a end as user_id,
                  s.username as sender_username, s.display_name as sender_display_name,
                  (c.accepted_at is null and c.started_by = m.sender_id) as request
             from claimed m
             join conversations c on c.id = m.conversation_id
             join users s on s.id = m.sender_id and s.status = 'active'
            where m.created_at > now() - interval '15 minutes' and m.read_at is null
              and ${canInteract("c.user_a", "c.user_b")}
              and exists (select 1 from push_subscriptions ps where ps.user_id = case when c.user_a = m.sender_id then c.user_b else c.user_a end)
            order by m.id`,
          [limit],
        )
      ).rows;
    },
  };
}

module.exports = { createPushStore };
