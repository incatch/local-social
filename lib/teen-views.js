// Teen mode pages: a parent's yes/no, the teen's waiting page, and the
// owner's Admin → Teen mode settings.

const { h, layout } = require("./views");
const { adminLayout } = require("./admin-views");

const hidden = (token) => `<input type="hidden" name="_token" value="${h(token)}">`;

/** What a parent is told about teen accounts (also on the consent page). */
function teenRulesList(settings) {
  const messages = {
    mutual: "They can only message teens they follow who follow them back.",
    followers: "They can only message teens who follow them.",
    requests: "Other teens can send them message requests, which they can accept or delete.",
  }[settings.teen_messages];
  const photos = {
    off: "They can't send or receive view-once photos.",
    mutual: "View-once photos only with teens they follow who follow them back.",
    on: "They can send view-once photos to teens they're chatting with.",
  }[settings.teen_photos];
  return `<ul>
  <li><strong>Teens only.</strong> Under-18s are in a separate part of ${h(settings.site_name)}: adults can't find them, see their posts or message them, and they can't see adults'.</li>
  <li>${messages}</li>
  <li>${photos}</li>
  <li>Their exact location is never stored or shown, only the nearest town${settings.teen_show_distance ? "" : " (no distances)"}.</li>
  <li>Every photo is checked automatically before anyone sees it${settings.teen_strict_screening ? ", and photos showing swimwear or partial nudity wait for a person to review them" : ""}.</li>
  <li>Anyone can report or block, and reports about under-18s are looked at first.</li>
</ul>`;
}

function consentPage({ settings, teen }) {
  return layout({
    title: "A parent's OK",
    siteName: settings.site_name,
    body: `<section class="card narrow">
  <h1>${h(teen.display_name)} wants to join ${h(settings.site_name)}</h1>
  <p>${h(settings.site_name)} is a site for sharing photos with people nearby. ${h(teen.display_name)} signed up as <strong>@${h(teen.username)}</strong> and gave your email as their parent's.</p>
  <h2>How it works for under-18s</h2>
  ${teenRulesList(settings)}
  <p class="muted small">Read the <a href="/terms" target="_blank">terms</a> and <a href="/privacy" target="_blank">privacy policy</a>.</p>
  <form method="post" class="row">
    <button type="submit" name="answer" value="yes">Yes, they can join</button>
    <button type="submit" name="answer" value="no" class="secondary" onclick="return confirm('This deletes their account. Continue?')">No, delete the account</button>
  </form>
</section>`,
  });
}

function waitingPage({ settings, user, formToken, notice = null, error = null }) {
  return layout({
    title: "Almost there",
    siteName: settings.site_name,
    body: `<section class="card narrow center">
  <h1>Almost there!</h1>
  <p>We emailed your parent at <strong>${h(user.parent_email)}</strong>. Once they say yes, you're in. (Refresh this page to check.)</p>
  ${notice ? `<p class="notice">${h(notice)}</p>` : ""}${error ? `<p class="error">${h(error)}</p>` : ""}
  <form method="post" action="/waiting/resend">${hidden(formToken)}<button type="submit" class="secondary">Send it again</button></form>
  <details class="spaced"><summary class="muted small">Use a different email</summary>
    <form method="post" action="/waiting/resend">${hidden(formToken)}
      <input type="email" name="parent_email" required maxlength="200" aria-label="Parent's email" placeholder="parent@example.com">
      <button type="submit" class="small">Send</button>
    </form>
  </details>
  <p class="muted small"><a href="/sign-out-page">Sign out</a></p>
</section>`,
  });
}

function adminTeenPage({ settings, admin, notice, counts }) {
  const t = settings;
  const radio = (name, value, label, current) =>
    `<label class="choice"><input type="radio" name="${name}" value="${value}"${current === value ? " checked" : ""}><span>${label}</span></label>`;
  const check = (name, on, label, hint) =>
    `<label class="switch"><input type="checkbox" name="${name}"${on ? " checked" : ""}><span class="track"></span><span>${label}${hint ? ` <span class="muted small">${hint}</span>` : ""}</span></label>`;
  return adminLayout({
    title: "Teen mode",
    settings,
    admin,
    body: `<h1>Teen mode</h1>
${notice ? `<p class="notice">${h(notice)}</p>` : ""}
<p class="muted">${counts.teens} teen account${counts.teens === 1 ? "" : "s"}${counts.waiting ? ` · ${counts.waiting} waiting for a parent` : ""}. Under-18s are always in their own world: adults and teens can't see, find or message each other. These settings decide the rest.</p>
<form method="post" action="/admin/teens">
  <input type="hidden" name="_token" value="${h(admin.formToken)}">
  <section class="card">
    ${check("teens_enabled", t.teens_enabled, "Let under-18s join", "Off: Radius is 18+. Check with your lawyer before turning this on.")}
    <label for="teen_min_age">Youngest age allowed</label>
    <select id="teen_min_age" name="teen_min_age">${[13, 14, 15, 16, 17].map((a) => `<option${a === t.teen_min_age ? " selected" : ""}>${a}</option>`).join("")}</select>
    <label for="teen_states">Only in these US states <span class="muted small">(two-letter codes, e.g. MO, KS; blank = anywhere)</span></label>
    <input type="text" id="teen_states" name="teen_states" value="${h(t.teen_states.join(", "))}" placeholder="MO">
    <div class="hint">When set, teens share their location once at sign-up so we can check (it also fills in their town).</div>
    <label for="parental_consent_under">A parent must OK accounts for teens under</label>
    <select id="parental_consent_under" name="parental_consent_under">${[0, 14, 15, 16, 17, 18].map((a) => `<option value="${a}"${a === t.parental_consent_under ? " selected" : ""}>${a === 0 ? "Never ask" : a === 18 ? "18 (all teens)" : a}</option>`).join("")}</select>
    <div class="hint">The teen gives a parent's email; the parent gets a link to say yes or no. Until then the teen can't use the site.</div>
  </section>
  <section class="card">
    <h2>Messages</h2>
    <fieldset class="choices"><legend>Teens can start chats with</legend>
      ${radio("teen_messages", "mutual", "Teens they follow who follow them back (safest)", t.teen_messages)}
      ${radio("teen_messages", "followers", "Teens who follow them", t.teen_messages)}
      ${radio("teen_messages", "requests", "Any teen, as a message request (like adults)", t.teen_messages)}
    </fieldset>
    <fieldset class="choices spaced"><legend>View-once photos for teens</legend>
      ${radio("teen_photos", "mutual", "Only with mutual follows", t.teen_photos)}
      ${radio("teen_photos", "off", "Off", t.teen_photos)}
      ${radio("teen_photos", "on", "On (in any chat)", t.teen_photos)}
    </fieldset>
  </section>
  <section class="card">
    <h2>Photos and Nearby</h2>
    ${check("teen_strict_screening", t.teen_strict_screening, "Stricter photo screening for teens", "Swimwear and partial nudity wait for your review.")}
    ${check("teen_show_distance", t.teen_show_distance, "Show distances to teens on Nearby", "Off: teens only see the town.")}
    <label for="teen_min_radius">Smallest Nearby distance teens can pick</label>
    <select id="teen_min_radius" name="teen_min_radius">${[5, 10, 25, 50].map((m) => `<option value="${m}"${m === t.teen_min_radius ? " selected" : ""}>${m} miles</option>`).join("")}</select>
  </section>
  <button type="submit" class="wide">Save</button>
</form>`,
  });
}

module.exports = { consentPage, waitingPage, adminTeenPage, teenRulesList };
