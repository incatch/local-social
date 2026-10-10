// Pages for reporting and blocking, and the owner's moderation pages.

const { h, layout, avatar } = require("./views");
const { adminLayout, when } = require("./admin-views");

const hidden = (token) => `<input type="hidden" name="_token" value="${h(token)}">`;
const errorBox = (error) => (error ? `<p class="error" role="alert">${h(error)}</p>` : "");

// ── For everyone ─────────────────────────────────────────────────────────

function reportPage({ settings, user, formToken, params, what, reasons, error = null }) {
  const keep = ["type", "id", "c"].map((k) => (params[k] ? `<input type="hidden" name="${k}" value="${h(params[k])}">` : "")).join("");
  const options = Object.entries(reasons)
    .map(([value, label]) => `<label class="choice"><input type="radio" name="reason" value="${value}" required${params.reason === value ? " checked" : ""}><span>${h(label)}</span></label>`)
    .join("");
  return layout({
    title: "Report",
    siteName: settings.site_name,
    user,
    body: `<h1>Report ${h(what)}</h1>
${errorBox(error)}
<form method="post" action="/report" class="card">${hidden(formToken)}${keep}
  <p class="muted small">Reports are private: they won't know it was you.</p>
  <fieldset class="choices"><legend>What's wrong?</legend>${options}</fieldset>
  <label for="details">Anything else we should know? <span class="muted small">(optional)</span></label>
  <textarea id="details" name="details" rows="3" maxlength="1000">${h(params.details)}</textarea>
  <label class="switch"><input type="checkbox" name="block"${params.block === "on" ? " checked" : ""}><span class="track"></span><span>Also block them <span class="muted small">You won't see each other or be able to message.</span></span></label>
  <button type="submit" class="wide">Send report</button>
</form>
<p class="muted small">If someone is in danger right now, call 911.</p>`,
  });
}

function reportedPage({ settings, user, blocked, minor, back }) {
  return layout({
    title: "Thanks",
    siteName: settings.site_name,
    user,
    body: `<section class="card narrow center">
  <h1>Thanks for telling us</h1>
  <p>${minor ? "Reports about anyone under 18 go to the top of the queue and are looked at right away." : "We'll look at it. If it breaks the rules, it'll come down."}</p>
  ${blocked ? "<p>You've also blocked them.</p>" : ""}
  <a class="button" href="${h(back)}">Done</a>
</section>`,
  });
}

function blockedProfilePage({ settings, user, formToken, profile }) {
  return layout({
    title: `@${profile.username}`,
    siteName: settings.site_name,
    user,
    body: `<section class="card narrow center">
  ${avatar(profile, "big")}
  <h1>@${h(profile.username)}</h1>
  <p class="muted">You've blocked this account. You won't see each other's posts, and you can't message each other.</p>
  <form method="post" action="/@${h(profile.username)}/unblock">${hidden(formToken)}<button type="submit" class="secondary">Unblock</button></form>
</section>`,
  });
}

// ── The owner's pages ────────────────────────────────────────────────────

const LEGAL_NOTE = `<details class="card legal-note"><summary><strong>If something involves a minor</strong></summary>
<ol>
  <li>Don't download, copy, forward or show it to anyone. Use <strong>Legal hold</strong>: it takes it down, keeps it locked away (never shown, never used for training) and bans the account.</li>
  <li>Report it to the NCMEC CyberTipline at <a href="https://report.cybertip.org" target="_blank" rel="noopener">report.cybertip.org</a>. US law requires providers to report apparent child sexual abuse material they become aware of.</li>
  <li>Keep it for at least a year (legal hold does this) and talk to a lawyer about anything you're unsure of.</li>
</ol></details>`;

function photosOf(keys = []) {
  return (keys || []).length ? `<div class="mod-photos">${keys.map((k) => `<img src="/admin/media/${h(k)}" alt="" loading="lazy">`).join("")}</div>` : "";
}
function labelsOf(labels) {
  const list = Array.isArray(labels) ? labels : [];
  return list.length ? `<p class="small muted">Screening: ${list.map((l) => `${h(l.name)} ${Math.round(l.confidence)}%`).join(", ")}</p>` : "";
}
function actions(path, token, { keep = true, remove = "Remove", dismiss = false, ban = false, offNearby = false } = {}) {
  return `<div class="mod-actions">
  <form method="post" action="${path}/remove">${hidden(token)}
    <label class="inline small"><input type="checkbox" name="ban"> also ban</label>
    <input type="text" name="note" placeholder="Note (optional)" maxlength="300">
    <button type="submit" class="small danger">${remove}</button>
  </form>
  ${offNearby ? `<form method="post" action="${path}/off-nearby">${hidden(token)}<button type="submit" class="small secondary">Keep up, off Nearby</button></form>` : ""}
  ${keep ? `<form method="post" action="${path}/keep">${hidden(token)}<button type="submit" class="small secondary">Keep it up</button></form>` : ""}
  ${dismiss ? `<form method="post" action="${path}/dismiss">${hidden(token)}<button type="submit" class="small secondary">Dismiss</button></form>` : ""}
  ${ban ? `<form method="post" action="${path}/ban">${hidden(token)}<button type="submit" class="small danger">Ban them</button></form>` : ""}
  <form method="post" action="${path}/legal-hold" onsubmit="return confirm('Legal hold: take it down, lock it away and ban the account?')">${hidden(token)}<button type="submit" class="small legal">Legal hold (minor)</button></form>
</div>`;
}

function queuePage({ settings, admin, notice, reports, held, reasons, timeZone }) {
  const t = admin.formToken;
  // Post and comment reports are grouped under the thing reported.
  const postReports = new Map();
  const commentReports = new Map();
  const other = [];
  for (const r of reports) {
    if (r.target_type === "post" && r.post_id) (postReports.get(r.post_id) || postReports.set(r.post_id, []).get(r.post_id)).push(r);
    else if (r.target_type === "comment" && r.comment_id) (commentReports.get(r.comment_id) || commentReports.set(r.comment_id, []).get(r.comment_id)).push(r);
    else other.push(r);
  }
  const reasonList = (rs) =>
    `<ul class="small">${rs.map((r) => `<li${r.reason === "minor" ? ' class="error-text"' : ""}><strong>${h(reasons[r.reason])}</strong> from @${h(r.reporter_username || "deleted")} · ${when(r.created_at, timeZone)}${r.details ? `: “${h(r.details)}”` : ""}</li>`).join("")}</ul>`;
  const heldIds = new Set(held.map((p) => String(p.id)));

  const cards = [];
  for (const p of held) {
    const rs = postReports.get(p.id) || [];
    cards.push(`<section class="card mod${rs.some((r) => r.reason === "minor") ? " urgent" : ""}">
  <h2>Post by <a href="/admin/users?q=${h(p.username)}">@${h(p.username)}</a>${p.target_teen ? ' <span class="badge">teen</span>' : ""} <span class="badge">Hidden, waiting for you</span></h2>
  ${photosOf(p.photo_keys)}${p.caption ? `<p>${h(p.caption)}</p>` : ""}${labelsOf(p.screen_labels)}
  ${rs.length ? reasonList(rs) : '<p class="small muted">Held by photo screening.</p>'}
  ${actions(`/admin/moderation/post/${p.id}`, t, { offNearby: true })}
</section>`);
  }
  for (const [postId, rs] of postReports) {
    if (heldIds.has(String(postId))) continue;
    const r = rs[0];
    cards.push(`<section class="card mod${rs.some((x) => x.reason === "minor") ? " urgent" : ""}">
  <h2>Post by @${h(r.target_username)}${r.target_teen ? ' <span class="badge">teen</span>' : ""} <span class="badge">${rs.length} report${rs.length === 1 ? "" : "s"}</span></h2>
  ${photosOf(r.post_photos)}${r.post_caption ? `<p>${h(r.post_caption)}</p>` : ""}
  ${reasonList(rs)}
  ${actions(`/admin/moderation/post/${postId}`, t, { offNearby: true })}
</section>`);
  }
  for (const [commentId, rs] of commentReports) {
    const r = rs[0];
    cards.push(`<section class="card mod${rs.some((x) => x.reason === "minor") ? " urgent" : ""}">
  <h2>Comment by @${h(r.target_username)}${r.target_teen ? ' <span class="badge">teen</span>' : ""} <span class="badge">${rs.length} report${rs.length === 1 ? "" : "s"}</span></h2>
  <blockquote>${h(r.comment_body ?? r.snapshot_text ?? "")}</blockquote>
  ${reasonList(rs)}
  ${actions(`/admin/moderation/comment/${commentId}`, t)}
</section>`);
  }
  for (const r of other) {
    const isSnap = Boolean(r.snapshot_key);
    cards.push(`<section class="card mod${r.reason === "minor" ? " urgent" : ""}">
  <h2>${{ user: "Account", post: "Deleted post by", comment: "Deleted comment by" }[r.target_type] || (isSnap ? "View-once photo from" : "Message from")} @${h(r.target_username)}${r.target_teen ? ' <span class="badge">teen</span>' : ""}${r.target_status === "banned" ? ' <span class="badge">banned</span>' : ""}</h2>
  ${isSnap && r.reason !== "minor" ? photosOf([r.snapshot_key]) : isSnap ? '<p class="small muted">Photo not shown (possible minor).</p>' : ""}
  ${r.snapshot_text ? `<blockquote>${h(r.snapshot_text)}</blockquote>` : ""}
  ${reasonList([r])}
  ${actions(`/admin/moderation/report/${r.id}`, t, { keep: false, dismiss: true, ban: r.target_status !== "banned", remove: r.target_type === "user" ? "Note it" : "Remove" })}
</section>`);
  }
  // Reports about minors first.
  cards.sort((a, b) => Number(b.includes(" urgent")) - Number(a.includes(" urgent")));
  return adminLayout({
    title: "Moderation",
    settings,
    admin,
    body: `<h1>Moderation</h1>
${notice ? `<p class="notice">${h(notice)}</p>` : ""}
${LEGAL_NOTE}
${cards.length ? cards.join("\n") : '<section class="card center muted">Nothing waiting. 🎉</section>'}`,
  });
}

function storePage({ settings, admin, items, decision, reasons, timeZone }) {
  const tabs = [
    ["", "Everything"],
    ["removed", "Removed"],
    ["refused", "Refused at upload"],
    ["legal_hold", "Legal hold"],
  ]
    .map(([v, label]) => `<a href="/admin/removed${v ? `?show=${v}` : ""}" class="${(decision || "") === v ? "on" : ""}">${label}</a>`)
    .join("");
  const rows = items
    .map(
      (it) => `<section class="card mod">
  <h2>${h({ snap: "view-once photo", upload: "post photo", avatar: "profile photo" }[it.source] || it.source)} by @${h(it.username || "deleted")} <span class="badge">${it.decision === "legal_hold" ? "legal hold" : h(it.decision)}</span>${it.training_ok ? "" : ' <span class="badge">not for training</span>'}</h2>
  <p class="small muted">${when(it.created_at, timeZone)}${it.report_reasons.length ? ` · reported for: ${it.report_reasons.map((r) => h(reasons[r] || r)).join(", ")}` : ""}${it.note ? ` · note: ${h(it.note)}` : ""}</p>
  ${it.decision === "legal_hold" ? '<p class="small muted">Locked away: not shown here.</p>' : `${photosOf(it.media_keys)}${it.body ? `<blockquote>${h(it.body)}</blockquote>` : ""}`}
  ${it.decision === "legal_hold" ? "" : labelsOf(it.labels)}
</section>`,
    )
    .join("\n");
  return adminLayout({
    title: "Removed",
    settings,
    admin,
    body: `<h1>Moderated out</h1>
<p class="muted">Everything taken down or refused, with the screening labels and report reasons, kept for your records and for training a moderation model later. Legal holds are locked away and never used for training.</p>
<nav class="segmented">${tabs}</nav>
${rows || '<section class="card center muted">Nothing here yet.</section>'}`,
  });
}

function nearbyRulesPage({ settings, admin, notice, posts, timeZone }) {
  const { DEFAULT_WORDS } = require("./politics");
  const words = settings.political_words ? settings.political_words : DEFAULT_WORDS.join("\n");
  const list = posts.length
    ? posts
        .map(
          (p) => `<li class="off-nearby">${p.thumb_key ? `<img src="/admin/media/${h(p.thumb_key)}" alt="">` : ""}<div class="grow">
  <div><a href="/p/${p.id}">@${h(p.username)}</a> · <span class="muted small">${when(p.created_at, timeZone)}</span></div>
  <div class="small">${h(p.nearby_reason || p.ai_reason || "")}</div>${p.caption ? `<div class="muted small">${h(p.caption.slice(0, 120))}</div>` : ""}</div>
  <form method="post" action="/admin/nearby/${p.id}/${p.nearby_override ? "hide" : "show"}">${hidden(admin.formToken)}<button type="submit" class="small ${p.nearby_override ? "secondary" : ""}">${p.nearby_override ? "Keep it off Nearby" : "Show on Nearby anyway"}</button></form>
</li>`,
        )
        .join("")
    : '<li class="muted">Nothing kept off Nearby yet.</li>';
  return adminLayout({
    title: "Nearby rules",
    settings,
    admin,
    body: `<h1>Nearby rules</h1>
${notice ? `<p class="notice">${h(notice)}</p>` : ""}
<p class="muted">Posts that look political stay off the Nearby feed. People who follow the poster still see them on the profile and in Following.</p>
<form method="post" action="/admin/nearby" class="card">${hidden(admin.formToken)}
  <label class="switch"><input type="checkbox" name="nearby_politics_filter"${settings.nearby_politics_filter ? " checked" : ""}><span class="track"></span><span>Keep political posts off Nearby <span class="muted small">Checks the caption, text in the photos (read automatically), and political figures in the photos.</span></span></label>
  <h2 class="spaced">Real photos</h2>
  <label class="switch"><input type="checkbox" name="nearby_ai_filter"${settings.nearby_ai_filter ? " checked" : ""}><span class="track"></span><span>Keep AI-made photos off Nearby <span class="muted small">When the photo itself says it was made with AI (content credentials or the AI tool's own label), or you decide so from a report. Followers still see them.</span></span></label>
  <label class="switch"><input type="checkbox" name="taken_here_badge"${settings.taken_here_badge ? " checked" : ""}><span class="track"></span><span>"Taken here" badge <span class="muted small">On posts whose photos the camera says were taken recently, close to where they were posted.</span></span></label>
  <div class="row">
    <label class="inline">Within <select name="taken_here_hours">${[6, 12, 24, 48, 72, 168].map((n) => `<option value="${n}"${n === settings.taken_here_hours ? " selected" : ""}>${n === 168 ? "a week" : `${n} hours`}</option>`).join("")}</select></label>
    <label class="inline">and <select name="taken_here_miles">${[1, 2, 5, 10, 25].map((n) => `<option value="${n}"${n === settings.taken_here_miles ? " selected" : ""}>${n} mile${n === 1 ? "" : "s"}</option>`).join("")}</select></label>
  </div>
  <h2 class="spaced">Politics</h2>
  <label for="political_words">Political words and phrases <span class="muted small">(one per line; whole words only, any capitalisation)</span></label>
  <textarea id="political_words" name="political_words" rows="10">${h(words)}</textarea>
  <label for="political_names">Extra political figures <span class="muted small">(one name per line; most are recognised automatically)</span></label>
  <textarea id="political_names" name="political_names" rows="3" placeholder="e.g. a local candidate">${h(settings.political_names || "")}</textarea>
  <button type="submit" class="wide">Save (and re-check the last 30 days of posts)</button>
</form>
<h2>Kept off Nearby</h2>
<ul class="activity">${list}</ul>`,
  });
}

module.exports = { nearbyRulesPage, reportPage, reportedPage, blockedProfilePage, queuePage, storePage };
