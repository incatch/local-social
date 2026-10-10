// Pages for messages, snaps and the Activity page.

const { h, layout, avatar } = require("./views");
const { ago } = require("./post-views");
const { icon } = require("./icons");
const { REQUEST_LIMIT, READ_HOURS } = require("./message-store");

const hidden = (token) => `<input type="hidden" name="_token" value="${h(token)}">`;
const errorBox = (error) => (error ? `<p class="error" role="alert">${h(error)}</p>` : "");

const other = (c) => ({ username: c.other_username, display_name: c.other_display_name, photo_key: c.other_photo_key });

function preview(c, viewerId) {
  if (c.unread) return `<strong>${c.unread === 1 ? (c.last_kind === "snap" && String(c.last_sender_id) !== String(viewerId) ? "New photo" : "New message") : `${c.unread} new messages`}</strong>`;
  if (!c.last_kind) return c.is_request || !c.accepted_at ? "Request sent" : "No messages";
  const mine = String(c.last_sender_id) === String(viewerId);
  const what = c.last_kind === "snap" ? (mine ? "Sent a photo" : "Photo") : `${mine ? "You: " : ""}${h(c.last_body.length > 60 ? `${c.last_body.slice(0, 60)}…` : c.last_body)}`;
  return `${what}${mine && c.last_read_at ? " · Seen" : ""}${!c.accepted_at && String(c.started_by) === String(viewerId) ? " · Request sent" : ""}`;
}

function inboxPage({ settings, user, conversations, requests, requestsPage = false, notice = null }) {
  const list = conversations.length
    ? `<ul class="inbox">${conversations
        .map(
          (c) => `<li><a href="/messages/${c.id}" class="${c.unread ? "unread" : ""}">${avatar(other(c))}<span class="grow"><strong>${h(c.other_display_name)}</strong><span class="muted small">${preview(c, user.id)}</span></span><span class="muted small">${ago(c.last_message_at)}</span></a></li>`,
        )
        .join("")}</ul>`
    : requestsPage
      ? '<section class="card center muted">No message requests.</section>'
      : `<section class="card center"><p>No messages yet.</p><p class="muted small">Open someone's profile and tap Message.</p></section>`;
  return layout({
    title: requestsPage ? "Message requests" : "Messages",
    siteName: settings.site_name,
    user,
    nav: "messages",
    body: `<h1>${requestsPage ? '<a href="/messages" class="back" aria-label="Back">${icon("back")}</a> Message requests' : "Messages"}</h1>
${notice ? `<p class="notice" role="status">${h(notice)}</p>` : ""}${requestsPage ? `<p class="muted small">From people you don't follow. They won't know you've seen a request until you accept it.</p>` : ""}
${!requestsPage && requests ? `<p><a class="button secondary small" href="/messages/requests">Message requests (${requests})</a></p>` : ""}
${list}`,
  });
}

/** The messages themselves (also sent on their own as the page checks for new ones). */
function messageList({ conversation, messages, user, formToken }) {
  if (!messages.length) return `<p class="muted small center">No messages yet. Say hi!</p>`;
  const lastMine = [...messages].reverse().find((m) => String(m.sender_id) === String(user.id));
  return messages
    .map((m) => {
      const mine = String(m.sender_id) === String(user.id);
      let content;
      if (m.kind === "snap") {
        if (mine) content = `<span class="snap-chip">📷 ${m.read_at ? "Opened" : "Photo sent"}</span>`;
        else if (m.photo_key)
          content = `<form method="post" action="/messages/${conversation.id}/snaps/${m.id}">${hidden(formToken)}<button type="submit" class="snap-chip new">📷 Tap to view photo</button></form>`;
        else content = `<span class="snap-chip">📷 Opened</span>`;
      } else content = `<span class="text">${h(m.body)}</span>`;
      const unsend = mine
        ? `<form method="post" action="/messages/${conversation.id}/unsend/${m.id}" class="unsend">${hidden(formToken)}<button type="submit" class="link small" aria-label="Unsend">Unsend</button></form>`
        : m.kind === "text" || m.report_key
          ? `<a class="muted" href="/report?type=message&amp;c=${conversation.id}&amp;id=${m.id}">Report</a>`
          : "";
      return `<li class="msg ${mine ? "mine" : "theirs"}" id="m${m.id}" data-id="${m.id}">${content}<div class="meta muted">${ago(m.created_at)}${m === lastMine && m.read_at ? " · Seen" : ""}${unsend}</div></li>`;
    })
    .join("");
}

function keepLine(c, formToken) {
  let says;
  if (c.i_keep && c.they_keep) says = "You both keep this chat, so messages are saved.";
  else if (c.i_keep) says = `You keep this chat. Messages still disappear ${READ_HOURS} hours after they're seen until @${h(c.other_username)} keeps it too.`;
  else if (c.they_keep) says = `@${h(c.other_username)} wants to keep this chat. Messages disappear ${READ_HOURS} hours after they're seen unless you keep it too.`;
  else says = `Messages disappear ${READ_HOURS} hours after they're seen. Photos you send open once.`;
  return `<form method="post" action="/messages/${c.id}/keep" class="keep">${hidden(formToken)}<input type="hidden" name="keep" value="${c.i_keep ? "" : "on"}">
  <span class="muted small">${says}</span> <button type="submit" class="link small">${c.i_keep ? "Stop keeping" : "Keep chat"}</button></form>`;
}

function chatPage({ settings, user, formToken, conversation: c, messages, error = null }) {
  const them = other(c);
  let top = "";
  if (c.request_to_me) {
    top = `<section class="card">
  <p><strong>@${h(c.other_username)}</strong> wants to message you. They won't know you've seen this unless you accept or reply.</p>
  <div class="row"><form method="post" action="/messages/${c.id}/accept">${hidden(formToken)}<button type="submit">Accept</button></form>
  <form method="post" action="/messages/${c.id}/delete" onsubmit="return confirm('Delete this request?')">${hidden(formToken)}<button type="submit" class="secondary">Delete</button></form></div>
</section>`;
  } else if (c.is_request) {
    top = `<p class="notice small">Message request sent. You can send up to ${REQUEST_LIMIT} messages (no photos) until @${h(c.other_username)} accepts.</p>`;
  }
  return layout({
    title: `@${c.other_username}`,
    siteName: settings.site_name,
    user,
    nav: "messages",
    body: `<header class="chat-head"><a href="/messages${c.request_to_me ? "/requests" : ""}" class="back" aria-label="Back">${icon("back")}</a><a href="/@${h(c.other_username)}" class="who">${avatar(them)}<span><strong>${h(c.other_display_name)}</strong><span class="muted small">@${h(c.other_username)}</span></span></a></header>
${errorBox(error)}${top}
${keepLine(c, formToken)}
<ul class="chat" data-chat="/messages/${c.id}/list">${messageList({ conversation: c, messages, user, formToken })}</ul>
${
  c.blocked
    ? '<p class="muted center">You can\'t message each other (one of you has blocked the other).</p>'
    : c.other_status === "active"
    ? `<form method="post" action="/messages/${c.id}" class="compose">${hidden(formToken)}
  <textarea name="body" rows="1" maxlength="1000" required placeholder="Message…" aria-label="Message"></textarea>
  <button type="submit" class="send" aria-label="Send">${icon("send", { size: 20 })}</button>
</form>
${
  c.is_request || c.photos_off
    ? ""
    : `<form method="post" action="/messages/${c.id}/snap?_token=${h(formToken)}" enctype="multipart/form-data" class="snap-form" data-snap>
  <label class="button secondary small snap-pick">${icon("camera", { size: 18 })} Send a photo <span class="muted small">opens once</span><input type="file" name="photo" accept="image/*" required></label>
  <noscript><button type="submit" class="small">Send photo</button></noscript>
  <span class="muted small" data-status hidden></span>
</form>`
}`
    : '<p class="muted center">This account is closed.</p>'
}`,
  });
}

function snapPage({ settings, user, conversation, messageId, image }) {
  return layout({
    title: "Photo",
    siteName: settings.site_name,
    user,
    nav: "messages",
    body: `<section class="snap-view">
  <p class="muted small">From @${h(conversation.other_username)}. Once you close it, it's gone.</p>
  <img src="data:${image.contentType};base64,${image.buffer.toString("base64")}" alt="Photo from @${h(conversation.other_username)}">
  <a class="button wide" href="/messages/${conversation.id}">Close</a>
  <p class="small"><a class="muted" href="/report?type=message&amp;c=${conversation.id}&amp;id=${h(messageId)}">Report this photo</a> <span class="muted">(you can for an hour)</span></p>
</section>`,
  });
}

function activityLine(n) {
  const who = `<a href="/@${h(n.actor_username)}"><strong>${h(n.actor_username)}</strong></a>`;
  const snippet = n.comment_body ? `: “${h(n.comment_body.length > 80 ? `${n.comment_body.slice(0, 80)}…` : n.comment_body)}”` : "";
  switch (n.kind) {
    case "like":
      return `${who} liked your post.`;
    case "comment":
      return `${who} commented${snippet}`;
    case "follow":
      return `${who} started following you.`;
    case "moment":
      return `<a href="/m/${h(n.detail)}"><strong>Your photo is part of a Moment: ${h(n.moment_title || "a Moment")}.</strong> See everyone's photos.</a>`;
    case "answer":
      return `${who} answered your ${n.signal_kind === "lost" ? "lost &amp; found" : "question"}: <a href="/s/${n.signal_id}">“${h(String(n.signal_body || "").slice(0, 60))}”</a>`;
    case "thanks":
      return `${who} 🙏 thanked you for your answer to <a href="/s/${n.signal_id}">“${h(String(n.signal_body || "").slice(0, 60))}”</a>`;
    case "flare":
      return `${who} is in for <a href="/s/${n.signal_id}">“${h(String(n.signal_body || "").slice(0, 60))}”</a> 🔥`;
    case "badge": {
      const b = require("./badges").BY_KEY[n.detail];
      return b ? `<a href="/badges"><strong>You earned a badge: ${b.emoji} ${h(b.name)}.</strong></a> ${h(b.how)}` : "You earned a badge.";
    }
    case "ripple":
      return `<strong>Your post rippled out to ${h(n.detail)} miles.</strong> People that far away can see it now.`;
    case "mention":
      return `${who} mentioned you in a ${n.comment_id ? "comment" : "post"}${snippet}`;
    default:
      return who;
  }
}

function activityPage({ settings, user, formToken, items, seenAt, prompt = "" }) {
  const list = items.length
    ? `<ul class="activity">${items
        .map((n) => {
          const end = n.post_id
            ? `<a href="/p/${n.post_id}${n.comment_id ? `#c${n.comment_id}` : ""}" class="thumb">${n.thumb_key ? `<img src="/${h(n.thumb_key)}" alt="">` : ""}</a>`
            : n.kind === "follow" && !n.following_back
              ? `<form method="post" action="/@${h(n.actor_username)}/follow">${hidden(formToken)}<input type="hidden" name="back" value="/activity"><button type="submit" class="small">Follow back</button></form>`
              : "";
          const fresh = new Date(n.created_at) > new Date(seenAt);
          return `<li class="${fresh ? "fresh" : ""}"><a href="/@${h(n.actor_username)}">${avatar({ username: n.actor_username, display_name: n.actor_display_name, photo_key: n.actor_photo_key })}</a><span class="grow">${activityLine(n)} <span class="muted small">${ago(n.created_at)}</span></span>${end}</li>`;
        })
        .join("")}</ul>`
    : `<section class="card center muted">When people like or comment on your posts, follow you, or mention you, it shows up here.</section>`;
  return layout({ title: "Activity", siteName: settings.site_name, user, nav: "activity", body: `<h1>Activity</h1>${prompt}${list}` });
}

module.exports = { inboxPage, chatPage, messageList, snapPage, activityPage };
