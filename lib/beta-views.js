// Beta polish pages: finding people, sending feedback, turning emails off,
// and Admin → Beta (how the beta is going).

const { h, layout, avatar } = require("./views");
const { icon } = require("./icons");
const { adminLayout, when } = require("./admin-views");
const { FEEDBACK_KINDS } = require("./beta-store");

const hidden = (token) => `<input type="hidden" name="_token" value="${h(token)}">`;
const errorBox = (error) => (error ? `<p class="error" role="alert">${h(error)}</p>` : "");
const noticeBox = (text) => (text ? `<p class="notice" role="status">${h(text)}</p>` : "");

function personRow(p, { formToken, back }) {
  return `<li class="person">
  <a href="/@${h(p.username)}" class="person-link">${avatar(p, "small")}<span><strong>${h(p.display_name)}</strong><span class="muted small">@${h(p.username)}${p.area_name ? ` · ${h(String(p.area_name).split(",")[0])}` : ""}</span></span></a>
  <form method="post" action="/@${h(p.username)}/follow">${hidden(formToken)}<input type="hidden" name="back" value="${h(back)}"><button type="submit" class="small${p.followed ? " secondary" : ""}">${p.followed ? "Following" : "Follow"}</button></form>
</li>`;
}

/** Just the results (the search box swaps these in as you type). */
function searchResults({ query, people, nearby, formToken }) {
  const back = query ? `/search?q=${encodeURIComponent(query)}` : "/search";
  if (query) {
    return people.length
      ? `<ul class="people">${people.map((p) => personRow(p, { formToken, back })).join("")}</ul>`
      : `<p class="muted center">Nobody called “${h(query)}” yet. <a href="/invite">Invite them</a>?</p>`;
  }
  return nearby.length
    ? `<h2 class="section-title">People around you</h2><ul class="people">${nearby.map((p) => personRow(p, { formToken, back })).join("")}</ul>`
    : `<p class="muted center">Search by name or @username.</p>`;
}

function searchPage({ settings, user, formToken, query, people, nearby }) {
  return layout({
    title: "Find people",
    siteName: settings.site_name,
    user,
    nav: "home",
    body: `<form method="get" action="/search" class="people-search" role="search">
  ${icon("search", { size: 18 })}
  <input type="search" name="q" value="${h(query)}" placeholder="Search people" aria-label="Search people" autocomplete="off" autocapitalize="none" spellcheck="false" data-people-search${query ? "" : " autofocus"}>
</form>
<div data-people-results>${searchResults({ query, people, nearby, formToken })}</div>`,
  });
}

function feedbackPage({ settings, user, formToken, from = "", values = {}, error = null }) {
  const kind = values.kind || "idea";
  return layout({
    title: "Send feedback",
    siteName: settings.site_name,
    user,
    nav: "profile",
    body: `<header class="around-head"><a href="${h(from || "/settings")}" class="back" aria-label="Back">${icon("back")}</a><h1>Send feedback</h1></header>
<p class="muted">You're one of the first people on ${h(settings.site_name)}. Tell us what's great, what's confusing, and what's broken. The people building it read every message.</p>
${errorBox(error)}
<form method="post" action="/feedback" class="card">
  ${hidden(formToken)}<input type="hidden" name="from" value="${h(from)}">
  <div class="kind-chips" role="radiogroup" aria-label="What kind of feedback">
    ${Object.entries(FEEDBACK_KINDS)
      .map(([k, label]) => `<label class="kind-chip"><input type="radio" name="kind" value="${k}"${k === kind ? " checked" : ""}><span>${h(label)}</span></label>`)
      .join("")}
  </div>
  <textarea name="body" rows="6" maxlength="2000" required placeholder="What happened, or what would make it better?" aria-label="Your feedback">${h(values.body)}</textarea>
  <button type="submit" class="wide">Send</button>
</form>`,
  });
}

function feedbackThanksPage({ settings, user, from }) {
  return layout({
    title: "Thank you",
    siteName: settings.site_name,
    user,
    nav: "profile",
    body: `<section class="card narrow center"><p class="big-emoji">🙏</p><h1>Thank you!</h1><p>We got it. Feedback like this is how ${h(settings.site_name)} gets better.</p>
<p><a class="button" href="${h(from || "/")}">Back</a></p></section>`,
  });
}

function emailsOffPage({ settings, action, done = false }) {
  return layout({
    title: "Emails",
    siteName: settings.site_name,
    body: done
      ? `<section class="card narrow center"><h1>Emails turned off</h1><p>We won't email you about messages or what's new any more. Sign-in codes still come by email.</p><p class="muted small">Changed your mind? Turn them back on in Settings.</p><p><a href="/">Open ${h(settings.site_name)}</a></p></section>`
      : `<section class="card narrow center"><h1>Turn off emails?</h1><p>No more emails about waiting messages or what's new around you. Sign-in codes still come by email.</p>
<form method="post" action="${h(action)}"><button type="submit">Turn them off</button></form></section>`,
  });
}

// ── Admin → Beta ─────────────────────────────────────────────────────────
const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : "—");

function betaPage({ settings, admin, stats, feedback, showDone, timeZone, notice, sources = [] }) {
  const tile = (n, label, sub = "") => `<div class="stat"><b>${n}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const dayLabel = (d) => new Date(`${String(d instanceof Date ? d.toISOString() : d).slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  const rows = stats.days
    .map((d) => `<tr><td>${dayLabel(d.day)}</td><td>${d.active}</td><td>${d.joined}</td><td>${d.posts}</td><td>${d.comments}</td><td>${d.messages}</td><td>${d.signals}</td><td>${d.emails}</td></tr>`)
    .join("");
  const list = feedback
    .map(
      (f) => `<li class="feedback-item">
  <div class="feedback-head"><span class="badge">${h(FEEDBACK_KINDS[f.kind] || f.kind)}</span> <strong>${f.username ? `@${h(f.username)}` : "(deleted account)"}</strong> <span class="muted small">${h(when(f.created_at, timeZone))}${f.page ? ` · on ${h(f.page)}` : ""}</span></div>
  <p class="feedback-body">${h(f.body)}</p>
  <div class="muted small">${f.email ? `${h(f.email)} · ` : ""}${h(f.device)}</div>
  <form method="post" action="/admin/beta/feedback/${f.id}/${f.done_at ? "reopen" : "done"}">${hidden(admin.formToken)}<button type="submit" class="small secondary">${f.done_at ? "Move back to open" : "Done"}</button></form>
</li>`,
    )
    .join("");
  return adminLayout({
    title: "Beta",
    settings,
    admin,
    body: `<h1>How the beta is going</h1>
${noticeBox(notice)}
<section class="card">
  <h2>People</h2>
  <div class="stats">
    ${tile(stats.members, "members", `${stats.new_week} joined this week`)}
    ${tile(stats.active_today, "here today")}
    ${tile(stats.active_week, "here this week")}
    ${tile(stats.active_month, "here this month")}
  </div>
  <div class="stats">
    ${tile(pct(stats.came_back, stats.came_back_of), "came back after day one", `${stats.came_back} of ${stats.came_back_of}`)}
    ${tile(pct(stats.stayed, stats.stayed_of), "still here after a week", `${stats.stayed} of ${stats.stayed_of} who joined 7+ days ago`)}
    ${tile(stats.from_members, "joined from a friend's invite")}
  </div>
  <p class="muted small">"Here" means they opened ${h(settings.site_name)} that day. Counting started with this update, so early numbers are low.</p>
</section>
<section class="card">
  <h2>The last 14 days</h2>
  <div class="table-wrap"><table class="daily">
    <thead><tr><th>Day</th><th>Here</th><th>Joined</th><th>Posts</th><th>Comments</th><th>Messages</th><th>Around you</th><th>Emails</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</section>
<section class="card" id="sources">
  <h2>Where members came from</h2>
  <p class="muted small">From the link they first arrived on (?utm_source=…&amp;utm_campaign=… on your ads).</p>
  ${sources.length ? `<table class="daily"><thead><tr><th>Ad or link</th><th>Members</th><th>This week</th></tr></thead><tbody>${sources.map((s) => `<tr><td>${h(s.source)}</td><td>${s.members}</td><td>${s.this_week}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">Nobody yet.</p>'}
</section>
<section class="card">
  <h2>Busiest towns (last 30 days)</h2>
  ${
    stats.towns.length
      ? `<table class="daily"><thead><tr><th>Town</th><th>Posts</th><th>People posting</th></tr></thead><tbody>${stats.towns.map((t) => `<tr><td>${h(t.town)}</td><td>${t.posts}</td><td>${t.people}</td></tr>`).join("")}</tbody></table>`
      : '<p class="muted">No posts with a place yet.</p>'
  }
</section>
<section class="card" id="emails">
  <h2>Email nudges</h2>
  <p>When it's on, people get an email when messages have waited an hour (at most one a day), and, if they've been away 3+ days, a weekly "what's new around you" (only when there is something new). Never what a message says.</p>
  <p class="muted small">${stats.nudges_off} member${stats.nudges_off === 1 ? " has" : "s have"} turned them off.</p>
  <form method="post" action="/admin/beta/emails">${hidden(admin.formToken)}<input type="hidden" name="on" value="${settings.email_nudges_enabled ? "false" : "true"}">
    <p><strong>${settings.email_nudges_enabled ? "On." : "Off."}</strong> <button type="submit" class="secondary small">${settings.email_nudges_enabled ? "Turn off for everyone" : "Turn on"}</button></p>
  </form>
</section>
<section class="card" id="feedback">
  <h2>Feedback ${showDone ? "(done)" : `(${stats.open_feedback} open)`}</h2>
  <p><a href="/admin/beta${showDone ? "" : "?show=done"}#feedback">${showDone ? "Show open feedback" : "Show done feedback"}</a></p>
  ${list ? `<ul class="feedback-list">${list}</ul>` : `<p class="muted">${showDone ? "Nothing marked done yet." : "No feedback waiting."}</p>`}
</section>`,
  });
}

module.exports = { searchPage, searchResults, feedbackPage, feedbackThanksPage, emailsOffPage, betaPage };
