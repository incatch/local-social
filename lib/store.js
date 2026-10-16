// Everything the site keeps in the database.

const crypto = require("crypto");
const { InputError } = require("./errors");
const { createPostStore } = require("./post-store");
const { rippleSettings } = require("./ripples");
const { createMessageStore } = require("./message-store");
const { createSafetyStore } = require("./safety-store");
const { createMomentStore } = require("./moment-store");
const { createSignalStore } = require("./signal-store");
const { createBetaStore } = require("./beta-store");
const { createPushStore } = require("./push-store");
const { createIrlStore } = require("./irl-store");
const { featureSettings, FEATURES, AUDIENCES } = require("./features");
const { BADGES, badgeQuery } = require("./badges");

const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
const MIN_AGE = 18; // adults; teens (if Admin turns teen mode on) from teen_min_age
const ADULT_AGE = 18;

// Usernames that would clash with the site's own pages or mislead people.
const RESERVED = new Set([
  "admin", "administrator", "api", "app", "help", "login", "logout", "media", "messages", "moderator",
  "privacy", "root", "settings", "sign-in", "signin", "signout", "static", "support", "system", "terms",
  "welcome", "localsocial", "local_social", "radius", "official", "staff", "team",
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

/** "YYYY-MM-DD" of the day someone born on `birthDate` turns `years`. */
function birthdayAt(birthDate, years) {
  const [y, m, d] = birthDate.split("-").map(Number);
  // Feb 29 birthdays count from Mar 1 in non-leap years.
  const day = new Date(Date.UTC(y + years, m - 1, d));
  return day.toISOString().slice(0, 10);
}
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

/** The teen-mode settings, with safe defaults (see migrations/006_teens.sql). */
function teenSettings(raw) {
  const int = (v, lo, hi, dflt) => {
    const n = Number.parseInt(v, 10);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
  };
  const oneOf = (v, list) => (list.includes(v) ? v : list[0]);
  return {
    teens_enabled: raw.teens_enabled === "true",
    teen_min_age: int(raw.teen_min_age, 13, 17, 13),
    teen_states: String(raw.teen_states || "")
      .split(/[\s,]+/)
      .map((x) => x.trim().toUpperCase())
      .filter((x) => /^[A-Z]{2}$/.test(x)),
    teen_messages: oneOf(raw.teen_messages, ["mutual", "followers", "requests"]),
    teen_photos: oneOf(raw.teen_photos, ["mutual", "off", "on"]),
    teen_strict_screening: raw.teen_strict_screening !== "false",
    teen_show_distance: raw.teen_show_distance === "true",
    teen_min_radius: [5, 10, 25, 50].includes(Number(raw.teen_min_radius)) ? Number(raw.teen_min_radius) : 10,
    parental_consent_under: int(raw.parental_consent_under, 0, 18, 0),
  };
}
const TEEN_KEYS = Object.keys(teenSettings({}));

/** An invite code people can read out: 8 letters/digits without look-alikes (0/O, 1/I). */
function newInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
}

class TeenLocationNeeded extends InputError {}
class ParentEmailNeeded extends InputError {}

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
    ...createMessageStore(pool),
    ...createSafetyStore(pool),
    ...createMomentStore(pool),
    ...createSignalStore(pool),
    ...createBetaStore(pool),
    ...createPushStore(pool),
    ...createIrlStore(pool),

    // ── Settings ─────────────────────────────────────────────────────────
    async settings() {
      const { rows } = await q("select key, value from settings");
      const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      s.invite_only = s.invite_only === "true";
      s.tagline = s.tagline || "";
      Object.assign(s, rippleSettings(s));
      s.moments_enabled = s.moments_enabled !== "false";
      s.signals_enabled = s.signals_enabled !== "false";
      s.invites_per_member = Math.max(0, Math.min(100, Number.parseInt(s.invites_per_member, 10) || 0));
      s.today_recap_enabled = s.today_recap_enabled !== "false";
      s.badges_enabled = s.badges_enabled !== "false";
      s.email_nudges_enabled = s.email_nudges_enabled !== "false";
      s.features = featureSettings(s);
      s.moment_people = Math.max(2, Number(s.moment_people) || 3);
      s.moment_miles = Number(s.moment_miles) > 0 ? Number(s.moment_miles) : 1;
      s.moment_hours = Math.max(1, Number(s.moment_hours) || 3);
      s.nearby_politics_filter = s.nearby_politics_filter !== "false";
      s.nearby_ai_filter = s.nearby_ai_filter !== "false";
      s.taken_here_badge = s.taken_here_badge !== "false";
      s.taken_here_hours = [6, 12, 24, 48, 72, 168].includes(Number(s.taken_here_hours)) ? Number(s.taken_here_hours) : 24;
      s.taken_here_miles = [1, 2, 5, 10, 25].includes(Number(s.taken_here_miles)) ? Number(s.taken_here_miles) : 5;
      return { ...s, ...teenSettings(s) };
    },
    /** Saves Admin → Teen mode (from the form; unchecked boxes mean off). */
    async setTeenSettings(form) {
      const t = teenSettings({
        ...form,
        teens_enabled: form.teens_enabled === "on" ? "true" : "false",
        teen_strict_screening: form.teen_strict_screening === "on" ? "true" : "false",
        teen_show_distance: form.teen_show_distance === "on" ? "true" : "false",
      });
      for (const key of TEEN_KEYS) {
        const value = Array.isArray(t[key]) ? t[key].join(",") : String(t[key]);
        await q("insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, value]);
      }
    },
    /** Saves Admin → Nearby rules. */
    async setNearbyRules(form) {
      const tidy = (v) => String(v || "").split(/\n|,/).map((x) => x.trim()).filter(Boolean).join("\n").slice(0, 20000);
      const values = {
        nearby_politics_filter: form.nearby_politics_filter === "on" ? "true" : "false",
        political_words: tidy(form.political_words),
        political_names: tidy(form.political_names),
        nearby_ai_filter: form.nearby_ai_filter === "on" ? "true" : "false",
        taken_here_badge: form.taken_here_badge === "on" ? "true" : "false",
        taken_here_hours: String(Number(form.taken_here_hours) || 24),
        taken_here_miles: String(Number(form.taken_here_miles) || 5),
      };
      if ("moment_people" in form) values.signals_enabled = form.signals_enabled === "on" ? "true" : "false";
      if ("invites_per_member" in form) {
        values.today_recap_enabled = form.today_recap_enabled === "on" ? "true" : "false";
        values.badges_enabled = form.badges_enabled === "on" ? "true" : "false";
        values.invites_per_member = String(Math.max(0, Math.min(100, Number.parseInt(form.invites_per_member, 10) || 0)));
      }
      if ("moment_people" in form) {
        values.moments_enabled = form.moments_enabled === "on" ? "true" : "false";
        values.moment_people = String(Math.max(2, Number(form.moment_people) || 3));
        values.moment_miles = String(Number(form.moment_miles) > 0 ? Number(form.moment_miles) : 1);
        values.moment_hours = String(Math.max(1, Number(form.moment_hours) || 3));
      }
      // Ripples and how long posts stay on Nearby (only when the form has them).
      if ("ripple_start_miles" in form) {
        const r = rippleSettings({ ...form, ripples_enabled: form.ripples_enabled === "on" ? "true" : "false" });
        for (const key of Object.keys(r)) values[key] = String(r[key]);
      }
      for (const [key, value] of Object.entries(values)) {
        await q("insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, value]);
      }
    },
    async teenCounts() {
      return one(
        `select count(*) filter (where teen_until > current_date and username is not null)::int as teens,
                count(*) filter (where teen_until > current_date and needs_parent_consent and parent_consent_at is null)::int as waiting
           from users`,
      );
    },
    /** Saves Admin → New features (each Off, 18+ only or Everyone). */
    async setFeatures(form) {
      for (const f of FEATURES) {
        const value = form[`feature_${f.key}`];
        if (AUDIENCES[value]) await q("insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [`feature_${f.key}`, value]);
      }
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
     * Finishes sign-up: invite code (while invite-only), date of birth (18+,
     * or 13+ in teen mode), username, name, and agreeing to the terms.
     * `region` is the US state they're in ("MO"), when teen mode limits states.
     * Returns the user; for teens who need a parent's OK, `consentToken` too.
     */
    async finishSignup(userId, form, { inviteOnly, settings = teenSettings({}), region = null, located = Boolean(region), today = new Date() }) {
      const age = ageOn(form.birth_date, today);
      if (age === null) throw new InputError("Please enter your date of birth.");
      if (age > 120) throw new InputError("Please check your date of birth.");
      const teen = age < ADULT_AGE;
      if (teen && !settings.teens_enabled) throw new InputError(`Sorry, you need to be ${ADULT_AGE} or older to use Radius for now.`);
      if (teen && age < settings.teen_min_age) throw new InputError(`Sorry, you need to be ${settings.teen_min_age} or older to use Radius.`);
      if (teen && settings.teen_states.length) {
        if (!located) throw new TeenLocationNeeded("Please share your location so we can check Radius is open to under-18s where you are.");
        if (!settings.teen_states.includes(region)) throw new InputError("Sorry, Radius isn't open to under-18s where you are yet.");
      }
      const consent = teen && age < settings.parental_consent_under;
      let parentEmail = null;
      if (consent) {
        parentEmail = normalEmail(form.parent_email);
        if (!isEmail(parentEmail)) throw new ParentEmailNeeded("Please enter a parent's email address. We'll ask them to OK your account.");
        const own = await one("select email from users where id = $1", [userId]);
        if (own && own.email === parentEmail) throw new ParentEmailNeeded("That's your own email. Please enter a parent's.");
      }
      const consentToken = consent ? crypto.randomBytes(24).toString("base64url") : null;
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
            `update users set username = $2, display_name = $3, adult_confirmed_at = case when $5::date is null then now() end,
                    terms_accepted_at = now(), invite_id = $4, teen_until = $5, needs_parent_consent = $6, parent_email = $7, parent_consent_token = $8
              where id = $1 and username is null returning *`,
            [userId, username, name, inviteId, teen ? birthdayAt(form.birth_date, ADULT_AGE) : null, consent, parentEmail, consentToken ? hashToken(consentToken) : null],
          );
          if (!user) throw new InputError("Your account is already set up.");
          if (consentToken) user.consentToken = consentToken;
          return user;
        } catch (err) {
          if (err.code === "23505") throw new InputError("That username is taken. Please pick another.");
          throw err;
        }
      });
    },

    // ── Parental consent (teen mode) ─────────────────────────────────────
    /** The teen a parent's link is for (null if the link is wrong or used). */
    async teenForConsent(token) {
      if (!token) return null;
      return one("select * from users where parent_consent_token = $1 and needs_parent_consent and parent_consent_at is null", [hashToken(token)]);
    },
    async approveConsent(userId) {
      await q("update users set parent_consent_at = now(), parent_consent_token = null where id = $1", [userId]);
    },
    /** A new link for the parent (and a new address, if given). Returns the token and address. */
    async renewConsent(userId, parentEmail = null) {
      const user = await one("select * from users where id = $1", [userId]);
      let email = user.parent_email;
      if (parentEmail) {
        email = normalEmail(parentEmail);
        if (!isEmail(email) || email === user.email) throw new InputError("Please enter a parent's email address.");
      }
      const token = crypto.randomBytes(24).toString("base64url");
      await q("update users set parent_email = $2, parent_consent_token = $3 where id = $1", [userId, email, hashToken(token)]);
      return { token, email };
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
        `select pp.photo_key, pp.thumb_key from post_photos pp join posts p on p.id = pp.post_id where p.user_id = $1
         union all
         select m.photo_key, m.report_key from messages m join conversations c on c.id = m.conversation_id
          where (m.photo_key is not null or m.report_key is not null) and $1 in (c.user_a, c.user_b)`,
        [userId],
      );
      const user = await one("delete from users where id = $1 returning photo_key", [userId]);
      return [...(user?.photo_key ? [user.photo_key] : []), ...rows.flatMap((r) => [r.photo_key, r.thumb_key]).filter(Boolean)];
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
    /** A member's own invite (made the first time they ask), or null when members can't invite. */
    async memberInvite(user, perMember) {
      if (!perMember) return null;
      const found = await one("select * from invites where created_by = $1 and revoked_at is null", [user.id]);
      if (found) {
        if (found.max_uses !== perMember) await q("update invites set max_uses = $2 where id = $1", [found.id, perMember]);
        return { ...found, max_uses: perMember };
      }
      for (;;) {
        try {
          return await one("insert into invites (code, note, max_uses, created_by) values ($1, $2, $3, $4) returning *", [newInviteCode(), `@${user.username}'s invite card`, perMember, user.id]);
        } catch (err) {
          if (err.code !== "23505") throw err;
          const again = await one("select * from invites where created_by = $1 and revoked_at is null", [user.id]);
          if (again) return again;
        }
      }
    },
    /** How many members are around a spot (by their Nearby spot or profile area). */
    async peopleNear(lat, lon, miles = 10) {
      const row = await one(
        `select count(*)::int as n from users
          where username is not null and status = 'active'
            and coalesce(feed_lat, area_lat) is not null
            and 3958.8 * 2 * asin(sqrt(power(sin(radians(coalesce(feed_lat, area_lat) - $1) / 2), 2)
                + cos(radians($1)) * cos(radians(coalesce(feed_lat, area_lat))) * power(sin(radians(coalesce(feed_lon, area_lon) - $2) / 2), 2))) <= $3`,
        [lat, lon, miles],
      );
      return row.n;
    },
    // ── Badges ───────────────────────────────────────────────────────────
    /** Checks someone's badges; saves and announces new ones. Returns the keys just earned. */
    async checkBadges(userId, { timeZone = "America/Chicago", rippleTop = 10 } = {}) {
      const met = await one(badgeQuery(), [userId, timeZone, rippleTop]);
      if (!met) return [];
      const earned = [];
      for (const b of BADGES) {
        if (!met[b.key]) continue;
        const added = await q("insert into user_badges (user_id, badge) values ($1, $2) on conflict do nothing", [userId, b.key]);
        if (added.rowCount) {
          earned.push(b.key);
          await q("insert into notifications (user_id, actor_id, kind, detail) values ($1, $1, 'badge', $2)", [userId, b.key]);
        }
      }
      return earned;
    },
    async badgesOf(userId) {
      return (await q("select badge, earned_at from user_badges where user_id = $1 order by earned_at", [userId])).rows;
    },
    async revokeInvite(id) {
      await q("update invites set revoked_at = now() where id = $1 and revoked_at is null", [id]);
    },
  };
}

module.exports = { createStore, InputError, TeenLocationNeeded, ParentEmailNeeded, checkUsername, ageOn, birthdayAt, teenSettings, MIN_AGE, ADULT_AGE };
