// Pages for posts: the feeds, a post, the new-post form and profile grids.

const { h, layout, avatar } = require("./views");
const { icon } = require("./icons");
const { milesBetween } = require("./places");
const { reachMiles } = require("./ripples");
// (signal-views requires this file, so it's loaded when first needed)
const aroundBar = (signals) => require("./signal-views").aroundBar(signals);
const { MAX_PHOTOS } = require("./post-store");

const hidden = (token) => `<input type="hidden" name="_token" value="${h(token)}">`;
const errorBox = (error) => (error ? `<p class="error" role="alert">${h(error)}</p>` : "");

/** Escaped text with @mentions linked to profiles and line breaks kept. */
function richText(text) {
  return h(text).replace(/(^|[^a-z0-9_.@&])@([a-z0-9_.]{3,30})/gi, (all, before, name) => {
    const clean = name.replace(/\.+$/, "");
    return `${before}<a href="/@${clean.toLowerCase()}">@${clean}</a>${name.slice(clean.length)}`;
  });
}

/** "5m", "3h", "2d", or a date for older things. */
function ago(time, now = Date.now()) {
  const s = Math.max(0, (now - new Date(time).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "Springfield, MO · 4 mi" (distance only on the Nearby feed; never closer than "within 2 mi"). */
function placeLabel(post, from) {
  if (!post.area_name) return "";
  let away = "";
  if (from && from.feed_lat !== null && from.feed_lat !== undefined && post.lat !== null) {
    const miles = milesBetween({ lat: from.feed_lat, lon: from.feed_lon }, post);
    away = miles < 2 ? " · within 2 mi" : ` · ${Math.round(miles)} mi`;
  }
  return `${h(post.area_name)}${away}`;
}

function photos(post, from, rippled = "") {
  const slides = post.photos
    .map(
      (ph, i) =>
        `<img src="/${h(ph.photo_key)}" width="${ph.width}" height="${ph.height}" alt="Photo ${i + 1} of ${post.photos.length}" loading="${i ? "lazy" : "eager"}">`,
    )
    .join("");
  const dots = post.photos.length > 1 ? `<div class="dots">${post.photos.map(() => "<span></span>").join("")}</div>` : "";
  const place = placeLabel(post, from);
  const taken = post.taken_here ? `<span class="taken" title="Taken recently, right where it was posted">${icon("check", { size: 13 })}Taken here</span>` : "";
  return `<div class="frame"><div class="carousel" data-carousel>${slides}</div>${place ? `<span class="place">${icon("pin", { size: 14 })}${place}</span>` : ""}${taken}${rippled}${dots}</div>`;
}

function likeButton(post, formToken) {
  return `<form method="post" action="/p/${post.id}/like" class="inline" data-like>${hidden(formToken)}
    <button type="submit" class="chip${post.liked ? " liked" : ""}" aria-pressed="${post.liked ? "true" : "false"}" aria-label="Like">${icon("heart", { size: 18, filled: post.liked })}<span data-like-count>${post.like_count}</span></button>
  </form>`;
}

/** One post as it appears in a feed (or on its own page). `from` is the viewer, for distances on Nearby. */
function postCard(post, { formToken, link = true, from = null, viewer = null, s = null } = {}) {
  // How far it has rippled (only once it's beyond the first ring).
  const reach = s && s.ripples_enabled && post.lat !== null ? reachMiles(post.like_count + post.comment_count, s) : null;
  const rippled = reach && reach > s.ripple_start_miles ? `<span class="rippled" title="Liked enough to reach people further away">${icon("ripple", { size: 14 })}Rippled to ${reach} mi</span>` : "";
  const mine = viewer && String(viewer.id) === String(post.user_id);
  const author = { username: post.username, display_name: post.display_name, photo_key: post.author_photo_key };
  return `<article class="post">
  ${post.status === "held" ? '<p class="held-note small">Only you can see this while it\'s being reviewed.</p>' : ""}
  ${mine && post.lat !== null && post.nearby_ok === false && !post.nearby_override ? '<p class="held-note small">Not shown on Nearby: it looks political. Your followers still see it.</p>' : ""}
  ${mine && post.lat !== null && post.nearby_ok !== false && post.ai_made && viewer.ai_filter !== false && !post.nearby_override ? '<p class="held-note small">Not shown on Nearby: Nearby is for photos taken around here. Your followers still see it.</p>' : ""}
  ${photos(post, from, rippled)}
  ${post.caption ? `<p class="caption">${richText(post.caption)}</p>` : ""}
  <footer class="post-foot">
    <a href="/@${h(post.username)}" class="who">${avatar(author, "small")}<span><strong>${h(post.display_name)}</strong><span class="muted small">@${h(post.username)} · <time>${ago(post.created_at)}</time></span></span></a>
    <div class="post-actions">
      ${likeButton(post, formToken)}
      <a class="chip" href="/p/${post.id}#comments" aria-label="Comments">${icon("comment", { size: 18 })}<span>${post.comment_count}</span></a>
      ${viewer && !mine ? `<a class="chip more" href="/report?type=post&amp;id=${post.id}" aria-label="Report this post">${icon("more", { size: 18 })}</a>` : ""}
    </div>
  </footer>
  ${link && post.comment_count ? `<p class="small more-comments"><a class="muted" href="/p/${post.id}#comments">${post.comment_count === 1 ? "1 comment" : `${post.comment_count} comments`} →</a></p>` : ""}
</article>`;
}

function more(posts, href) {
  return posts.hasMore ? `<p class="more"><a class="button secondary" href="${h(href)}">Load more</a></p>` : "";
}

/** "Happening now" Moments at the top of Nearby. */
function momentsStrip(moments) {
  if (!moments.length) return "";
  return `<section class="moments" aria-label="Moments nearby">${moments
    .map((m) => {
      const live = Date.now() - new Date(m.last_post_at).getTime() < 3 * 3600 * 1000;
      const thumbs = (m.thumbs || []).filter(Boolean);
      return `<a class="moment-card" href="/m/${m.id}">
  <div class="mosaic n${Math.min(thumbs.length, 4)}">${thumbs.map((t) => `<img src="/${h(t)}" alt="" loading="lazy">`).join("")}</div>
  <div class="moment-text">${live ? '<span class="live">● Happening now</span>' : '<span class="muted small">Earlier</span>'}
    <strong>${h(m.title)}</strong>
    <span class="muted small">${m.people} people · ${m.photos} post${m.photos === 1 ? "" : "s"}</span></div>
</a>`;
    })
    .join("")}</section>`;
}

function momentPage({ settings, user, formToken, moment, posts }) {
  const people = new Set(posts.map((p) => String(p.user_id))).size;
  return layout({
    title: moment.title,
    siteName: settings.site_name,
    user,
    nav: "home",
    body: `<header class="moment-head">
  <a href="/" class="back" aria-label="Back">${icon("back")}</a>
  <div><h1>${h(moment.title)}</h1>
  <p class="muted small">${icon("pin", { size: 13 })} ${h(moment.area_name || "")} · ${people} people · ${posts.length} post${posts.length === 1 ? "" : "s"} · started ${ago(moment.started_at) === "now" ? "just now" : `${ago(moment.started_at)} ago`}</p></div>
</header>
<p class="muted small">A Moment is made automatically when several people post from the same spot around the same time. Post from here while it's going on and yours joins in.</p>
${posts.map((p) => postCard(p, { formToken, viewer: user, s: settings })).join("\n")}`,
  });
}

function feedPage({ settings, user, formToken, tab, posts, page, notice = null, error = null, newCount = 0, yearAgo = [], moments = [], signals = null }) {
  const tabs = `<nav class="segmented" aria-label="Feeds"><a href="/?tab=nearby" class="${tab === "nearby" ? "on" : ""}">Nearby</a><a href="/?tab=following" class="${tab === "following" ? "on" : ""}">Following</a></nav>`;
  let top = "";
  if (tab === "nearby") {
    const radius = [5, 10, 25, 50]
      .filter((m) => m >= (user.min_radius || 0))
      .map((m) => `<button type="submit" name="miles" value="${m}" class="ring${m === Math.max(user.feed_radius_miles, user.min_radius || 0) ? " on" : ""}" aria-pressed="${m === Math.max(user.feed_radius_miles, user.min_radius || 0)}">${m} mi</button>`)
      .join("");
    top = `<div class="feed-bar">
  <form method="post" action="/feed/radius" class="rings" aria-label="How far">${hidden(formToken)}${radius}</form>
  <form method="post" action="/feed/location" data-locate class="inline">${hidden(formToken)}<input type="hidden" name="lat"><input type="hidden" name="lon">
    <button type="submit" class="ring locate" aria-label="${user.feed_lat === null ? "Use my location" : "Update my location"}">${icon("pin", { size: 16 })}<span>${user.feed_lat === null ? "Use my location" : "Update"}</span></button></form>
</div>
<p class="error small" data-locate-error hidden></p>`;
  }
  let body;
  if (tab === "nearby" && user.feed_lat === null) {
    body = `<section class="card center empty">${icon("pin", { size: 32 })}<p>See what people within ${user.feed_radius_miles} miles are posting.</p><p class="muted small">Your location is rounded to about a mile and never shown to anyone.</p></section>`;
  } else if (!posts.length && page === 0) {
    body =
      tab === "nearby"
        ? `<section class="card center"><p>Nothing posted within ${user.feed_radius_miles} miles yet.</p><p><a class="button" href="/new">Be the first</a></p></section>`
        : `<section class="card center"><p>Follow people to see their posts here.</p><p class="muted small">Find them on the Nearby feed and tap their name.</p></section>`;
  } else {
    body = posts.map((p) => postCard(p, { formToken, viewer: user, s: settings, from: tab === "nearby" && user.show_distance !== false ? user : null })).join("\n") + more(posts, `/?tab=${tab}&page=${page + 1}`);
    if (tab === "nearby" && !posts.hasMore) body += caughtUp(user, settings);
  }
  if (tab === "nearby" && newCount > 0 && page === 0) {
    body = `<p class="new-chip">${icon("ripple", { size: 16 })}${newCount} new nearby since you last looked</p>${body}`;
  }
  if (tab === "nearby" && yearAgo.length) body += yearAgoStrip(yearAgo);
  if (tab === "nearby") body = momentsStrip(moments) + (signals && user.feed_lat !== null ? aroundBar(signals) : "") + body;
  return layout({
    siteName: settings.site_name,
    user,
    nav: "home",
    body: `${tabs}${errorBox(error)}${notice ? `<p class="notice">${h(notice)}</p>` : ""}${top}${body}`,
  });
}

/** The end of Nearby: no endless scroll. */
function caughtUp(user, settings) {
  const miles = Math.max(user.feed_radius_miles, user.min_radius || 0);
  return `<section class="caught-up">
  <div class="rings-mark" aria-hidden="true"><span></span><span></span><span></span></div>
  <h2>You're all caught up</h2>
  <p class="muted">That's everything within ${miles} miles from the last ${settings.nearby_days === 1 ? "day" : `${settings.nearby_days} days`}. Go enjoy it.</p>
  <p><a class="button secondary small" href="/new">Share what's around you</a></p>
</section>`;
}

/** "On this spot, a year ago": old local photos from this week in past years. */
function yearAgoStrip(posts) {
  const years = new Date().getFullYear() - new Date(posts[0].created_at).getFullYear();
  return `<section class="year-ago">
  <h2>${icon("pin", { size: 16 })} Around here, ${years <= 1 ? "a year ago" : `${years} years ago`}</h2>
  <div class="strip">${posts
    .map((p) => `<a href="/p/${p.id}" class="cell"><img src="/${h(p.photos[0]?.thumb_key)}" alt="" loading="lazy"><span>${new Date(p.created_at).getFullYear()}</span></a>`)
    .join("")}</div>
</section>`;
}

function postPage({ settings, user, formToken, post, comments, moment = null, error = null }) {
  const own = post.user_id === user.id;
  const list = comments
    .map(
      (c) => `<li id="c${c.id}">
  <a href="/@${h(c.username)}"><strong>${h(c.username)}</strong></a> ${richText(c.body)}
  <div class="muted small">${ago(c.created_at)}${
    c.user_id === user.id || own
      ? ` · <form method="post" action="/p/${post.id}/comments/${c.id}/delete" class="inline">${hidden(formToken)}<button type="submit" class="link small">Delete</button></form>`
      : ""
  }${c.user_id !== user.id ? ` · <a class="muted" href="/report?type=comment&amp;id=${c.id}">Report</a>` : ""}</div>
</li>`,
    )
    .join("");
  return layout({
    title: `${post.username}'s post`,
    siteName: settings.site_name,
    user,
    body: `${errorBox(error)}${moment ? `<a class="in-moment" href="/m/${moment.id}">${icon("ripple", { size: 16 })} Part of <strong>${h(moment.title)}</strong> · see everyone's photos</a>` : ""}${postCard(post, { formToken, link: false, viewer: user, s: settings })}
${
  own
    ? `<details class="card"><summary>Edit or delete</summary>
  <form method="post" action="/p/${post.id}/caption">${hidden(formToken)}
    <label for="caption">Caption</label><textarea id="caption" name="caption" rows="3" maxlength="2200">${h(post.caption)}</textarea>
    <button type="submit">Save caption</button>
  </form>
  <form method="post" action="/p/${post.id}/delete" class="spaced" onsubmit="return confirm('Delete this post?')">${hidden(formToken)}<button type="submit" class="danger">Delete post</button></form>
</details>`
    : ""
}
<section class="card" id="comments">
  <h2>Comments</h2>
  ${list ? `<ul class="comments">${list}</ul>` : '<p class="muted">No comments yet.</p>'}
  <form method="post" action="/p/${post.id}/comments" class="comment-form">${hidden(formToken)}
    <textarea name="body" rows="2" maxlength="1000" required placeholder="Add a comment… (@name to mention someone)" aria-label="Comment"></textarea>
    <button type="submit">Post</button>
  </form>
</section>`,
  });
}

function newPostPage({ settings, user, formToken, error = null, caption = "" }) {
  return layout({
    title: "New post",
    siteName: settings.site_name,
    user,
    nav: "new",
    body: `<h1>New post</h1>
${errorBox(error)}
${settings.signals_enabled ? `<nav class="send-row small-row" aria-label="Or send to people around you"><span class="muted small">Or send to people around you:</span>
  <a class="send-chip" href="/around/new?kind=ask">❓ Ask</a><a class="send-chip" href="/around/new?kind=plan">🔥 Plan</a><a class="send-chip" href="/around/new?kind=lost">🐾 Lost &amp; found</a><a class="send-chip" href="/around/new?kind=poll">📊 Poll</a></nav>` : ""}
<form method="post" action="/new?_token=${h(formToken)}" enctype="multipart/form-data" class="composer" data-new-post>
  <div class="picker" data-picker>
    <div class="tiles" data-previews></div>
    <label class="add-tile" for="photos">
      <span class="add-icons">${icon("camera", { size: 28 })}${icon("images", { size: 28 })}</span>
      <strong data-add-label>Add photos</strong>
      <span class="muted small">Take a photo or choose from your library · up to ${MAX_PHOTOS}</span>
      <input type="file" id="photos" name="photos" accept="image/*" multiple required>
    </label>
  </div>
  <textarea id="caption" name="caption" rows="3" maxlength="2200" placeholder="What's happening? (@name to mention someone)" aria-label="Caption">${h(caption)}</textarea>
  <label class="switch"><input type="checkbox" name="with_location" checked><span class="track"></span><span>Show on Nearby <span class="muted small">Adds your town. Your location is rounded to about a mile.</span></span></label>
  <input type="hidden" name="lat"><input type="hidden" name="lon">
  <button type="submit" class="wide" data-submit>Share</button>
  <p class="muted small center" data-status hidden></p>
</form>`,
  });
}

/** The profile: header, counts, follow button, and a grid of posts. */
function profilePage({ settings, user, formToken, profile, stats, posts, page }) {
  const own = user.id === profile.id;
  const grid = posts.length
    ? `<div class="grid">${posts
        .map((p) => `<a href="/p/${p.id}" class="cell"><img src="/${h(p.photos[0]?.thumb_key)}" alt="" loading="lazy">${p.photos.length > 1 ? '<span class="multi">❐</span>' : ""}</a>`)
        .join("")}</div>${posts.hasMore ? `<p class="more"><a class="button secondary" href="/@${h(profile.username)}?page=${page + 1}">Load more</a></p>` : ""}`
    : `<section class="grid-empty muted">${own ? '<a class="button" href="/new">Share your first post</a>' : "No posts yet."}</section>`;
  return layout({
    title: `@${profile.username}`,
    siteName: settings.site_name,
    user,
    nav: own ? "profile" : "",
    body: `<section class="profile">
  <div class="profile-head">
    ${avatar(profile, "big")}
    <div>
      <h1>${h(profile.display_name)}</h1>
      <div class="muted">@${h(profile.username)}${profile.area_name ? ` · ${h(profile.area_name)}` : ""}</div>
    </div>
  </div>
  <div class="counts"><span><strong>${stats.posts}</strong> ${stats.posts === 1 ? "post" : "posts"}</span><span><strong>${stats.followers}</strong> ${stats.followers === 1 ? "follower" : "followers"}</span><span><strong>${stats.following}</strong> following</span></div>
  ${profile.bio ? `<p class="bio">${richText(profile.bio)}</p>` : ""}
  ${
    own
      ? '<p><a class="button secondary small" href="/settings">Edit profile</a></p>'
      : `<div class="row profile-buttons"><form method="post" action="/@${h(profile.username)}/follow">${hidden(formToken)}<button type="submit" class="small${stats.followed ? " secondary" : ""}">${stats.followed ? "Following" : "Follow"}</button></form>
    <form method="post" action="/@${h(profile.username)}/message">${hidden(formToken)}<button type="submit" class="small secondary">Message</button></form></div>
    <details class="profile-more"><summary aria-label="More">${icon("more")}</summary>
      <a href="/report?type=user&amp;id=${h(profile.username)}">Report @${h(profile.username)}</a>
      <form method="post" action="/@${h(profile.username)}/block" onsubmit="return confirm('Block @${h(profile.username)}? You won\'t see each other\'s posts or be able to message.')">${hidden(formToken)}<button type="submit" class="link">Block @${h(profile.username)}</button></form>
    </details>`
  }
</section>
${grid}`,
  });
}

module.exports = { momentPage, feedPage, postPage, newPostPage, profilePage, postCard, richText, ago };
