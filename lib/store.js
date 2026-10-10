// Everything the site keeps in the database.

const crypto = require("crypto");
const { InputError } = require("./errors");
const { createPostStore } = require("./post-store");

const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
const MIN_AGE = 18;

// Usernames that would clash with the site's own pages or mislead people.
const RESERVED = new Set([
  "admin", "administrator", "api", "app", "help", "login", "logout", "media", "messages", "moderator",
  "privacy", "root", "settings", "sign-in", "signin", "signout", "static", "support", "system", "terms",
  "welcome", "localsocial", "local_social", "official", "staff", "team",
]);

function normalEmail(email) {
  return String(email || "").trim().toLowerCase();
}
function isEmail(email) {
  return /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/.test(email) && email.length <= 200;
}
function hashCode(email, code) {
  return crypto.createHash("sha256").update(`${email}:${code}`).digest("hex");
}

function checkUsername(value) {
  const username = String(value || "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_.]{3,30}$/.test(username)) {
    throw new InputError("Usernames are 3–30 letters, numbers, underscores or periods.");
  }
  if (username.startsWith(".") || username.endsWith(".") || username.includes("..")) {
    throw new InputError("A username can't start or end with a period, or have two in a row.");
  }
  if (RESERVED.has(username)) throw new InputError("That username isn't available.");
  return username;
}
function checkDisplayName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 50) throw new InputError("Please enter a name to show on your profile (up to 50 characters).");
  return name;
}
function checkBio(value) {
  const bio = String(value || "").trim().replace(/\r\n/g, "\n");
  if (bio.length > 300) throw new InputError("Your bio can be up to 300 characters.");
  return bio;
}

/** Age in whole years on `today` for a "YYYY-MM-DD" birth date, or null if it isn't a real date. */
function ageOn(birthDate, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthDate || ""));
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const born = new Date(Date.UTC(y, mo - 1, d));
  if (born.getUTCMonth() !== mo - 1 || born.getUTCDate() !== d || y < 1900) return null;
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() < mo - 1 || (today.getUTCMonth() === mo - 1 && today.getUTCDate() < d)) age -= 1;
  return age;
}

/** An invite code people can read out: 8 letters/digits without look-alikes (0/O, 1/I). */
function newInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
}

function createStore(pool) {
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await q(text, params)).rows[0] || null;

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    ...createPostStore(pool),

    // ── Settings ─────────────────────────────────────────────────────────
    async settings() {
      const { rows } = await q("select key, value from settings");
      const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      s.invite_only = s.invite_only === "true";
      return s;
    },
    async setInviteOnly(on) {
      await q("update settings set value = $1 where key = 'invite_only'", [on ? "true" : "false"]);
    },

    // ── Sign-in codes ────────────────────────────────────────────────────
    /** A new 6-digit code for `email` (only its hash is kept). */
    async newSigninCode(email) {
      email = normalEmail(email);
      if (!isEmail(email)) throw new InputError("Enter your email address.");
      const recent = await one(
        "select count(*)::int as n from signin_codes where email = $1 and created_at > now() - interval '1 hour'",
        [email],
      );
      if (recent.n >= CODES_PER_HOUR) throw new InputError("Too many codes requested. Please wait a while and try again.");
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      await q(
        `insert into signin_codes (email, code_hash, expires_at) values ($1, $2, now() + make_interval(mins => $3))`,
        [email, hashCode(email, code), CODE_MINUTES],
      );
      return { email, code, minutes: CODE_MINUTES };
    },

    /** Checks a code; on success, the user (an unfinished account on first sign-in). */
    async useSigninCode(email, code) {
      email = normalEmail(email);
      code = String(code || "").replace(/\s/g, "");
      // Wrong guesses must be counted even though the sign-in fails, so the
      // outcome is decided inside the transaction and reported after it.
      const result = await tx(async (db) => {
        const {
          rows: [row],
        } = await db.query(`select * from signin_codes where email = $1 and used_at is null order by created_at desc limit 1 for update`, [email]);
        if (!row || new Date(row.expires_at) < new Date() || row.attempts >= CODE_ATTEMPTS) return { error: "expired" };
        if (!/^\d{6}$/.test(code) || hashCode(email, code) !== row.code_hash) {
          await db.query("update signin_codes set attempts = attempts + 1 where id = $1", [row.id]);
          return { error: "wrong" };
        }
        await db.query("update signin_codes set used_at = now() where id = $1", [row.id]);
        const {
          rows: [user],
        } = await db.query(
          `insert into users (email) values ($1) on conflict (email) do update set email = excluded.email returning *`,
          [email],
        );
        return { user };
      });
      if (result.error === "expired") throw new InputError("That code has expired. Please ask for a new one.");
      if (result.error === "wrong") throw new InputError("That code isn't right. Please check it and try again.");
      if (result.user.status === "banned") throw new InputError("This account has been closed for breaking the rules.");
      return result.user;
    },

    // ── Users ────────────────────────────────────────────────────────────
    async user(id) {
      return one("select * from users where id = $1", [id]);
    },
    async userByUsername(username) {
      return one("select * from users where username = $1", [String(username || "").toLowerCase()]);
    },
    async touch(id) {
      await q("update users set last_seen_at = now() where id = $1", [id]);
    },

    /**
     * Finishes sign-up: invite code (while invite-only), date of birth (18+),
     * username, name, and agreeing to the terms.
     */
    async finishSignup(userId, form, { inviteOnly, today = new Date() }) {
      const age = ageOn(form.birth_date, today);
      if (age === null) throw new InputError("Please enter your date of birth.");
      if (age < MIN_AGE) throw new InputError(`Sorry, you need to be ${MIN_AGE} or older to use this site.`);
      if (age > 120) throw new InputError("Please check your date of birth.");
      if (form.terms !== "on") throw new InputError("Please agree to the terms and privacy policy to continue.");
      const username = checkUsername(form.username);
      const name = checkDisplayName(form.display_name);
      return tx(async (db) => {
        let inviteId = null;
        if (inviteOnly) {
          const code = String(form.invite || "").trim().toUpperCase().replace(/[\s-]/g, "");
          const {
            rows: [invite],
          } = await db.query(
            `update invites set uses = uses + 1
              where code = $1 and revoked_at is null and uses < max_uses returning id`,
            [code],
          );
          if (!invite) throw new InputError("That invite code isn't valid (or has been used up).");
          inviteId = invite.id;
        }
        try {
          const {
            rows: [user],
          } = await db.query(
            `update users set username = $2, display_name = $3, adult_confirmed_at = now(), terms_accepted_at = now(), invite_id = $4
              where id = $1 and username is null returning *`,
            [userId, username, name, inviteId],
          );
          if (!user) throw new InputError("Your account is already set up.");
          return user;
        } catch (err) {
          if (err.code === "23505") throw new InputError("That username is taken. Please pick another.");
          throw err;
        }
      });
    },

    async updateProfile(userId, form) {
      const username = checkUsername(form.username);
      try {
        return await one(
          "update users set username = $2, display_name = $3, bio = $4 where id = $1 returning *",
          [userId, username, checkDisplayName(form.display_name), checkBio(form.bio)],
        );
      } catch (err) {
        if (err.code === "23505") throw new InputError("That username is taken. Please pick another.");
        throw err;
      }
    },
    /** Sets the profile photo; returns the old one's key (to delete). */
    async setPhoto(userId, key) {
      const old = await one("select photo_key from users where id = $1", [userId]);
      await q("update users set photo_key = $2 where id = $1", [userId, key]);
      return old?.photo_key || null;
    },
    /** Sets the profile's area: `place` is { lat, lon } (already rounded) and the town's name. */
    async setArea(userId, place, name) {
      await q("update users set area_lat = $2, area_lon = $3, area_name = $4 where id = $1", [userId, place?.lat ?? null, place?.lon ?? null, name]);
    },
    async signOutEverywhere(userId) {
      return one("update users set session_version = session_version + 1 where id = $1 returning *", [userId]);
    },
    /** Deletes an account and everything they posted. Returns the photo keys to remove from storage. */
    async deleteUser(userId) {
      const { rows } = await q(
        "select pp.photo_key, pp.thumb_key from post_photos pp join posts p on p.id = pp.post_id where p.user_id = $1",
        [userId],
      );
      const user = await one("delete from users where id = $1 returning photo_key", [userId]);
      return [...(user?.photo_key ? [user.photo_key] : []), ...rows.flatMap((r) => [r.photo_key, r.thumb_key])];
    },

    // ── Admin ────────────────────────────────────────────────────────────
    async users({ search = "", limit = 200 } = {}) {
      const text = String(search || "").trim().toLowerCase();
      return (
        await q(
          `select u.*, i.code as invite_code, i.note as invite_note from users u left join invites i on i.id = u.invite_id
            where $1 = '' or u.email like '%' || $1 || '%' or u.username like '%' || $1 || '%' or lower(u.display_name) like '%' || $1 || '%'
            order by u.created_at desc limit $2`,
          [text, limit],
        )
      ).rows;
    },
    async userCounts() {
      return one(
        `select count(*) filter (where username is not null and status = 'active')::int as active,
                count(*) filter (where username is null)::int as unfinished,
                count(*) filter (where status = 'banned')::int as banned
           from users`,
      );
    },
    async ban(userId, reason) {
      const why = String(reason || "").trim().slice(0, 300);
      if (!why) throw new InputError("Please say why (the person isn't shown this; it's for your records).");
      await q("update users set status = 'banned', banned_reason = $2, session_version = session_version + 1 where id = $1", [userId, why]);
    },
    async unban(userId) {
      await q("update users set status = 'active', banned_reason = null where id = $1", [userId]);
    },

    async invites() {
      return (
        await q(
          `select i.*, (select count(*)::int from users u where u.invite_id = i.id) as joined
             from invites i order by i.created_at desc`,
        )
      ).rows;
    },
    async createInvite({ note, max_uses }) {
      const uses = Number(max_uses || 1);
      if (!Number.isInteger(uses) || uses < 1 || uses > 1000) throw new InputError("Uses must be a whole number from 1 to 1000.");
      for (;;) {
        try {
          return await one("insert into invites (code, note, max_uses) values ($1, $2, $3) returning *", [
            newInviteCode(),
            String(note || "").trim().slice(0, 100),
            uses,
          ]);
        } catch (err) {
          if (err.code !== "23505") throw err; // the same random code twice: try again
        }
      }
    },
    async revokeInvite(id) {
      await q("update invites set revoked_at = now() where id = $1 and revoked_at is null", [id]);
    },
  };
}

module.exports = { createStore, InputError, checkUsername, ageOn, MIN_AGE };
