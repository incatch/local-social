// The admin pages (behind the household sign-in at the load balancer).

const { h, avatar } = require("./views");

const hidden = (token) => `<input type="hidden" name="_token" value="${h(token)}">`;
const when = (t, timeZone) =>
  t ? new Date(t).toLocaleString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";

function adminLayout({ title, settings, admin, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} · ${h(settings.site_name)} admin</title>
<link rel="stylesheet" href="/static/css/style.css">
</head>
<body class="admin">
<header class="top"><a class="brand" href="/admin">${h(settings.site_name)}</a> <span class="badge">Admin</span></header>
<nav class="admin-nav">
  <a href="/admin">Overview</a> <a href="/admin/moderation">Moderation</a> <a href="/admin/removed">Removed</a> <a href="/admin/users">Users</a> <a href="/admin/invites">Invites</a> <a href="/admin/nearby">Nearby rules</a> <a href="/admin/teens">Teen mode</a>
  <span class="who">${h(admin.email)}${admin.signOutUrl ? ` · <a href="${h(admin.signOutUrl)}">Sign out</a>` : ""}</span>
</nav>
<main>
${body}
</main>
</body>
</html>`;
}

function notice(text) {
  return text ? `<p class="notice" role="status">${h(text)}</p>` : "";
}
function errorBox(text) {
  return text ? `<p class="error" role="alert">${h(text)}</p>` : "";
}

function overview({ settings, admin, counts, moderation = { reports: 0, minor: 0, held: 0 }, notice: done }) {
  return adminLayout({
    title: "Overview",
    settings,
    admin,
    body: `<h1>Overview</h1>
${notice(done)}
<section class="card">
  <h2>Moderation</h2>
  ${moderation.minor ? `<p class="error"><strong>${moderation.minor} report${moderation.minor === 1 ? "" : "s"} about minors.</strong> Please look now.</p>` : ""}
  <p>${moderation.reports} open report${moderation.reports === 1 ? "" : "s"} · ${moderation.held} post${moderation.held === 1 ? "" : "s"} waiting for review</p>
  <p><a class="button small" href="/admin/moderation">Open the queue</a></p>
</section>
<section class="card">
  <h2>People</h2>
  <p>${counts.active} active · ${counts.unfinished} signed in but haven't finished joining · ${counts.banned} banned</p>
</section>
<section class="card">
  <h2>Who can join</h2>
  <p>${settings.invite_only ? "<strong>Invite only.</strong> New people need an invite code (Invites)." : "<strong>Open.</strong> Anyone 18+ can join."}</p>
  <form method="post" action="/admin/invite-only">${hidden(admin.formToken)}
    <input type="hidden" name="on" value="${settings.invite_only ? "false" : "true"}">
    <button type="submit" class="secondary">${settings.invite_only ? "Open sign-ups to everyone" : "Make it invite only"}</button>
  </form>
</section>`,
  });
}

function users({ settings, admin, list, search, timeZone, notice: done, error }) {
  const rows = list
    .map(
      (u) => `<tr>
  <td>${avatar(u, "tiny")}</td>
  <td>${u.username ? `<a href="/@${h(u.username)}">@${h(u.username)}</a>${u.teen_until && String(u.teen_until) > new Date().toISOString().slice(0, 10) ? ' <span class="badge">teen</span>' : ""}${u.needs_parent_consent && !u.parent_consent_at ? ' <span class="badge">waiting for parent</span>' : ""}<div>${h(u.display_name)}</div>` : '<span class="muted">(hasn\'t finished joining)</span>'}<div class="muted small">${h(u.email)}</div></td>
  <td>${h(u.area_name || "")}</td>
  <td class="small">${h(when(u.created_at, timeZone))}${u.invite_code ? `<div class="muted">invite ${h(u.invite_code)}${u.invite_note ? ` (${h(u.invite_note)})` : ""}</div>` : ""}</td>
  <td>${
    u.status === "banned"
      ? `<span class="error-text">Banned</span><div class="muted small">${h(u.banned_reason)}</div>
         <form method="post" action="/admin/users/${u.id}/unban">${hidden(admin.formToken)}<button class="small secondary" type="submit">Unban</button></form>`
      : `<details><summary>Ban</summary><form method="post" action="/admin/users/${u.id}/ban">${hidden(admin.formToken)}
           <input name="reason" placeholder="Why (for your records)" required maxlength="300"><button class="small danger" type="submit">Ban</button></form></details>`
  }</td>
</tr>`,
    )
    .join("");
  return adminLayout({
    title: "Users",
    settings,
    admin,
    body: `<h1>Users</h1>
${notice(done)}${errorBox(error)}
<form method="get" action="/admin/users" class="row"><input name="q" value="${h(search)}" placeholder="Search name, @username or email"><button type="submit">Search</button></form>
<div class="table-wrap"><table><tr><th></th><th>Who</th><th>Area</th><th>Joined</th><th></th></tr>${rows || '<tr><td colspan="5" class="muted">Nobody yet.</td></tr>'}</table></div>
<p class="muted small">Banning signs them out everywhere and stops them signing in again.</p>`,
  });
}

function invites({ settings, admin, list, siteUrl, timeZone, notice: done, error }) {
  const rows = list
    .map((i) => {
      const live = !i.revoked_at && i.uses < i.max_uses;
      return `<tr>
  <td><strong class="mono">${h(i.code)}</strong><div class="muted small">${h(i.note)}</div></td>
  <td>${i.uses} of ${i.max_uses} used${i.joined ? ` · ${i.joined} joined` : ""}</td>
  <td class="small">${h(when(i.created_at, timeZone))}</td>
  <td>${
    i.revoked_at
      ? '<span class="muted">Revoked</span>'
      : live
        ? `<input class="copy" readonly value="${h(`${siteUrl}/join/${i.code}`)}" aria-label="Invite link">
           <form method="post" action="/admin/invites/${i.id}/revoke">${hidden(admin.formToken)}<button class="small secondary" type="submit">Revoke</button></form>`
        : '<span class="muted">Used up</span>'
  }</td>
</tr>`;
    })
    .join("");
  return adminLayout({
    title: "Invites",
    settings,
    admin,
    body: `<h1>Invites</h1>
${notice(done)}${errorBox(error)}
<section class="card">
  <h2>New invite</h2>
  <p class="muted">Send the person the link (or just the code). It works for as many people as you allow.</p>
  <form method="post" action="/admin/invites" class="row">${hidden(admin.formToken)}
    <input name="note" placeholder="Who it's for (e.g. Sam from work)" maxlength="100">
    <label class="inline">Uses <input name="max_uses" type="number" min="1" max="1000" value="1" style="width:5em"></label>
    <button type="submit">Create invite</button>
  </form>
</section>
<div class="table-wrap"><table><tr><th>Code</th><th>Used</th><th>Created</th><th>Link</th></tr>${rows || '<tr><td colspan="4" class="muted">No invites yet.</td></tr>'}</table></div>`,
  });
}

module.exports = { overview, users, invites, adminLayout, when };
