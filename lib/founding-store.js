// Founding members (part of the store): the first 500 can join without an
// invite while the owner has founding sign-ups open; then a waitlist.

const { InputError } = require("./errors");

const tidySource = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9_./-]/g, "")
    .slice(0, 60) || null;

function createFoundingStore(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;

  return {
    /** { members, limit, left, open } — open means people can join without an invite right now. */
    async foundingStatus(settings) {
      const { n } = await one("select count(*)::int as n from users where username is not null");
      const left = Math.max(0, settings.founding_limit - n);
      return { members: n, limit: settings.founding_limit, left, open: settings.founding_open && left > 0, area: settings.founding_area };
    },
    /** Someone's place in line: #1 is the first person who joined. */
    async memberNumber(userId) {
      const row = await one(
        `select (select count(*)::int from users f where f.username is not null and (f.created_at, f.id) <= (u.created_at, u.id)) as n
           from users u where u.id = $1 and u.username is not null`,
        [userId],
      );
      return row ? row.n : null;
    },
    async setFounding(form) {
      const values = {
        founding_open: form.founding_open === "on" ? "true" : "false",
        founding_limit: String(Math.max(1, Math.min(100000, Number.parseInt(form.founding_limit, 10) || 500))),
        founding_area: String(form.founding_area || "").trim().slice(0, 40) || "Springfield",
      };
      for (const [key, value] of Object.entries(values)) {
        await q("insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, value]);
      }
    },
    async setSignupSource(userId, source) {
      const s = tidySource(source);
      if (s) await q("update users set signup_source = $2 where id = $1 and signup_source is null", [userId, s]);
    },
    async signupSources() {
      return (
        await q(
          `select coalesce(signup_source, 'direct / word of mouth') as source, count(*)::int as members,
                  count(*) filter (where created_at > now() - interval '7 days')::int as this_week
             from users where username is not null group by 1 order by members desc limit 30`,
        )
      ).rows;
    },

    // ── Waitlist ─────────────────────────────────────────────────────────
    async joinWaitlist(email, source) {
      const e = String(email || "").trim().toLowerCase();
      if (!/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/.test(e) || e.length > 200) throw new InputError("Please enter a valid email address.");
      await q("insert into waitlist (email, source) values ($1, $2) on conflict (email) do nothing", [e, tidySource(source)]);
    },
    async waitlist({ invited = false } = {}) {
      return (await q(`select * from waitlist where (invited_at is not null) = $1 order by created_at limit 500`, [invited])).rows;
    },
    async waitlistCount() {
      return (await one("select count(*)::int as n from waitlist where invited_at is null")).n;
    },
    async waitlistEntry(id) {
      return one("select * from waitlist where id = $1", [id]);
    },
    async markWaitlistInvited(id, inviteId) {
      await q("update waitlist set invited_at = now(), invite_id = $2 where id = $1", [id, inviteId]);
    },
  };
}

module.exports = { createFoundingStore, tidySource };
