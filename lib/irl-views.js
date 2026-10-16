// Pull Up (on posts and plans) and the Squads pages.

const { h, layout, avatar } = require("./views");
const { icon } = require("./icons");
const { ago } = require("./post-views");
const { SQUAD_EMOJI, SQUAD_MAX } = require("./irl-store");

const hidden = (token) => `<input type="hidden" name="_token" value="${h(token)}">`;
const errorBox = (error) => (error ? `<p class="error" role="alert">${h(error)}</p>` : "");

/** The Pull Up card under a post or plan. `base` is "/p/12" or "/s/34". */
function pullUpBlock({ base, own, mine, list, formToken, open }) {
  const here = list.filter((p) => p.status === "here");
  const coming = list.filter((p) => p.status === "coming");
  const faces = here
    .map(
      (p) => `<a href="/@${h(p.username)}" class="pullup-face" title="${h(p.display_name)}">${
        p.photo_key ? `<img src="/${h(p.photo_key)}" alt="${h(p.display_name)}">` : avatar({ username: p.username, display_name: p.display_name, photo_key: p.avatar_key })
      }<span>${h(String(p.display_name).split(" ")[0])}</span></a>`,
    )
    .join("");
  const counts = [here.length ? `${here.length} pulled up` : "", coming.length ? `${coming.length} on the way` : ""].filter(Boolean).join(" · ");
  let action = "";
  if (!own && open) {
    if (!mine) {
      action = `<form method="post" action="${base}/pullup">${hidden(formToken)}<button type="submit">🙋 Pull up</button></form>
  <p class="muted small">Let them know you're on your way. Nobody sees where you are.</p>`;
    } else if (mine.status === "coming") {
      action = `<p><strong>You're on your way.</strong> Tap when you get there.</p>
  <div class="row"><form method="post" action="${base}/pullup/here" data-locate>${hidden(formToken)}<input type="hidden" name="lat"><input type="hidden" name="lon"><button type="submit">I'm here 👋</button></form>
  <form method="post" action="${base}/pullup/cancel">${hidden(formToken)}<button type="submit" class="link small">Not coming after all</button></form></div>
  <p class="error small" data-locate-error hidden></p>`;
    } else if (!mine.photo_key) {
      action = `<p><strong>You pulled up 👋</strong> Add a quick selfie to the wall?</p>
  <form method="post" action="${base}/pullup/selfie?_token=${h(formToken)}" enctype="multipart/form-data" class="photo-pick" data-photo-form>
    <label class="button secondary small">${icon("camera", { size: 16 })} Add a selfie<input type="file" name="photo" accept="image/*" capture="user" hidden></label>
    <noscript><button type="submit" class="small">Upload</button></noscript>
  </form>`;
    } else action = "<p><strong>You pulled up 👋</strong></p>";
  }
  if (!faces && !counts && !action) return "";
  return `<section class="card pullup" id="pullup">
  <h2>🙋 Pull Up</h2>
  ${faces ? `<div class="pullup-faces">${faces}</div>` : ""}
  ${counts ? `<p class="muted small">${counts}</p>` : own ? '<p class="muted small">When people pull up, they show up here.</p>' : ""}
  ${action}
</section>`;
}

const flame = (n) => (n ? `<span class="streak${n >= 4 ? " hot" : ""}">🔥 ${n} week${n === 1 ? "" : "s"}</span>` : '<span class="streak cold">No streak yet</span>');

function squadsPage({ settings, user, formToken, squads, streaks, error = null, notice = null }) {
  const invites = squads.filter((s) => s.my_status === "invited");
  const mine = squads.filter((s) => s.my_status === "member");
  return layout({
    title: "Squads",
    siteName: settings.site_name,
    user,
    nav: "messages",
    body: `<header class="around-head"><a href="/messages" class="back" aria-label="Back">${icon("back")}</a><h1>Squads</h1></header>
<p class="muted">Your crew, up to ${SQUAD_MAX}. Keep your streak going by doing real things together each week: post from the same spot, go to the same plan, pull up together.</p>
${errorBox(error)}${notice ? `<p class="notice" role="status">${h(notice)}</p>` : ""}
${invites
  .map(
    (s) => `<section class="card squad-invite"><p><strong>@${h(s.invited_by_username || "someone")}</strong> invited you to <strong>${h(s.emoji)} ${h(s.name)}</strong></p>
  <div class="row"><form method="post" action="/squads/${s.id}/accept">${hidden(formToken)}<button type="submit" class="small">Join</button></form>
  <form method="post" action="/squads/${s.id}/decline">${hidden(formToken)}<button type="submit" class="small secondary">No thanks</button></form></div></section>`,
  )
  .join("")}
${
  mine.length
    ? `<ul class="squad-list">${mine
        .map((s) => `<li><a href="/squads/${s.id}"><span class="squad-emoji">${h(s.emoji)}</span><span class="grow"><strong>${h(s.name)}</strong><span class="muted small">${s.members} ${s.members === 1 ? "person" : "people"}</span></span>${flame(streaks[s.id])}</a></li>`)
        .join("")}</ul>`
    : ""
}
<details class="card" ${mine.length ? "" : "open"}><summary><strong>Start a squad</strong></summary>
<form method="post" action="/squads/new">${hidden(formToken)}
  <label for="squad-name">Name</label>
  <input type="text" id="squad-name" name="name" maxlength="30" required placeholder="The Saturday crew">
  <div class="emoji-pick" role="radiogroup" aria-label="Emoji">${SQUAD_EMOJI.map((e, i) => `<label><input type="radio" name="emoji" value="${e}"${i === 0 ? " checked" : ""}><span>${e}</span></label>`).join("")}</div>
  <button type="submit" class="wide">Start the squad</button>
</form></details>`,
  });
}

function squadPage({ settings, user, formToken, squad, members, messages, candidates, streak, thisWeek, error = null }) {
  const owner = String(squad.created_by) === String(user.id);
  const memberList = members
    .map(
      (m) => `<li>${avatar(m, "small")}<a href="/@${h(m.username)}" class="grow">${h(m.display_name)} <span class="muted small">@${h(m.username)}${m.status === "invited" ? " · invited" : ""}</span></a>${
        owner && String(m.id) !== String(user.id)
          ? `<form method="post" action="/squads/${squad.id}/remove">${hidden(formToken)}<input type="hidden" name="user" value="${m.id}"><button type="submit" class="link small">Remove</button></form>`
          : ""
      }</li>`,
    )
    .join("");
  const chat = messages
    .map((m) => `<li class="${String(m.user_id) === String(user.id) ? "mine" : ""}" data-id="${m.id}"><span class="who">${h(m.display_name)}</span><span class="text">${h(m.body)}</span><span class="when">${ago(m.created_at)}</span></li>`)
    .join("");
  return layout({
    title: squad.name,
    siteName: settings.site_name,
    user,
    nav: "messages",
    body: `<header class="around-head"><a href="/squads" class="back" aria-label="Back">${icon("back")}</a><h1>${h(squad.emoji)} ${h(squad.name)}</h1></header>
${errorBox(error)}
<section class="card streak-card${streak ? "" : " none"}">
  <div class="streak-big">🔥<b>${streak}</b></div>
  <div><strong>${streak ? `${streak}-week streak` : "Start your streak"}</strong>
  <p class="small">${
    thisWeek
      ? `✓ This week: you ${h(thisWeek)}. See you next week!`
      : streak
        ? "Not yet this week. Post from the same spot, go to the same plan, or pull up together before Sunday night to keep it."
        : "Do something real together this week: post from the same spot, go to the same plan, or pull up together."
  }</p></div>
</section>
<section class="card squad-chat">
  <h2>Chat</h2>
  <ul class="squad-messages" data-squad-chat="${squad.id}">${chat || '<li class="empty muted small">Say hi to the squad. Messages disappear after 7 days.</li>'}</ul>
  <form method="post" action="/squads/${squad.id}/say" class="comment-form" data-squad-say>${hidden(formToken)}
    <textarea name="body" rows="1" maxlength="1000" required placeholder="Message the squad" aria-label="Message"></textarea>
    <button type="submit">Send</button>
  </form>
</section>
<section class="card">
  <h2>People</h2>
  <ul class="blocked">${memberList}</ul>
  ${
    members.length < SQUAD_MAX
      ? candidates.length
        ? `<form method="post" action="/squads/${squad.id}/invite" class="row">${hidden(formToken)}
    <select name="username" aria-label="Friend to invite">${candidates.map((c) => `<option value="${h(c.username)}">${h(c.display_name)} (@${h(c.username)})</option>`).join("")}</select>
    <button type="submit" class="small">Invite</button></form>`
        : '<p class="muted small">You can invite friends who follow you and you follow back.</p>'
      : `<p class="muted small">The squad is full (${SQUAD_MAX}).</p>`
  }
  <form method="post" action="/squads/${squad.id}/leave" onsubmit="return confirm('Leave ${h(squad.name).replace(/'/g, "")}?')" class="spaced">${hidden(formToken)}<button type="submit" class="link small">Leave the squad</button></form>
</section>`,
  });
}

module.exports = { pullUpBlock, squadsPage, squadPage, flame };
