// Growth: the daily "Today in <town>" recap, members' invite cards, and
// visiting another town. The shareable images are drawn on the phone
// (public/js/app.js) so they use the site's own font and look sharp.

const { h, layout } = require("./views");
const { icon } = require("./icons");

const townOf = (label) => String(label || "").split(",")[0] || "town";

/** The town chip on Nearby: tap it to update your spot, pick a nearby town, or search. */
function townPicker({ user, formToken, here, around = [], visiting = null }) {
  const current = visiting || here || "Set location";
  return `<details class="town-picker">
  <summary class="ring locate">${icon("pin", { size: 16 })}<span>${h(townOf(current))}</span></summary>
  <div class="town-panel">
    <form method="post" action="/feed/location" data-locate>
      <input type="hidden" name="_token" value="${h(formToken)}"><input type="hidden" name="lat"><input type="hidden" name="lon">
      <button type="submit" class="wide small">${icon("pin", { size: 16 })} ${user.feed_lat === null ? "Use my location" : "Update to where I am now"}</button>
    </form>
    <p class="error small" data-locate-error hidden></p>
    <form method="get" action="/" class="town-search">
      <input type="hidden" name="tab" value="nearby">
      <input type="search" name="visit" list="town-list" placeholder="Visit another town…" autocomplete="off" aria-label="Visit another town" data-town-search>
      <datalist id="town-list"></datalist>
      <button type="submit" class="small">Go</button>
    </form>
    ${
      around.length
        ? `<div class="town-chips"><span class="muted small">Peek at:</span>${around
            .map((t) => `<a class="send-chip" href="/?tab=nearby&amp;visit=${encodeURIComponent(t.label)}">${h(townOf(t.label))}</a>`)
            .join("")}</div>`
        : ""
    }
  </div>
</details>`;
}

function visitBanner(label) {
  return `<div class="visit-banner">${icon("pin", { size: 16 })}<span>Visiting <strong>${h(label)}</strong>. Look around; posts you share still come from where you are.</span><a href="/?tab=nearby">Back home</a></div>`;
}

/** The card on Nearby in the evening: today's recap is ready. */
function recapCard(town) {
  return `<a class="recap-card" href="/today"><span class="recap-spark">✨</span><span><strong>Today in ${h(town)}</strong><span class="muted small">Your recap is ready to share</span></span>${icon("next", { size: 18 })}</a>`;
}

function todayPage({ settings, user, town, dateLabel, posts }) {
  const photos = posts.map((p) => p.photos[0]).filter(Boolean);
  const spec = { kind: "recap", title: `Today in ${townOf(town)}`, date: dateLabel, photos: photos.slice(0, 6).map((ph) => `/${ph.photo_key}`), site: settings.site_name };
  return layout({
    title: spec.title,
    siteName: settings.site_name,
    user,
    nav: "home",
    body: `<header class="around-head"><a href="/?tab=nearby" class="back" aria-label="Back">${icon("back")}</a><h1>${h(spec.title)}</h1></header>
<p class="muted">${h(dateLabel)} · ${posts.length} moment${posts.length === 1 ? "" : "s"} from people around you</p>
${
  photos.length
    ? `<div class="recap-preview">${photos
        .slice(0, 6)
        .map((ph, i) => `<a href="/p/${posts[i].id}"><img src="/${h(ph.thumb_key)}" alt=""></a>`)
        .join("")}</div>
<button type="button" class="wide" data-share-card='${h(JSON.stringify(spec))}'>${icon("send", { size: 18 })} Share today's recap</button>
<p class="muted small center">Made for Instagram and Snapchat stories, TikTok, or a text to a friend.</p>
<p class="small center" data-share-status hidden></p>`
    : '<section class="card center muted">Not much shared around you today yet. Check back this evening.</section>'
}`,
  });
}

function invitePage({ settings, user, invite, link, qrSvg, peopleNearby, town }) {
  if (!invite) {
    return layout({ title: "Invite", siteName: settings.site_name, user, body: '<section class="card center muted">Invites are closed right now.</section>' });
  }
  const left = Math.max(0, invite.max_uses - invite.uses);
  const spec = {
    kind: "invite",
    name: user.display_name,
    town: townOf(town),
    people: peopleNearby,
    link,
    qr: `data:image/svg+xml;base64,${Buffer.from(qrSvg).toString("base64")}`,
    site: settings.site_name,
    tagline: settings.tagline || "Your world. Happening now.",
  };
  return layout({
    title: "Invite friends",
    siteName: settings.site_name,
    user,
    nav: "profile",
    body: `<h1>Invite friends</h1>
<section class="invite-card">
  <div class="rings-mark" aria-hidden="true"><span></span><span></span><span></span></div>
  <p class="invite-from">${h(user.display_name)} invited you to</p>
  <p class="invite-brand">${h(settings.site_name)}</p>
  <p class="invite-where">${h(townOf(town))}${peopleNearby > 1 ? ` · ${peopleNearby} people nearby` : ""}</p>
  <div class="invite-qr">${qrSvg}</div>
  <p class="muted small">${h(spec.tagline)}</p>
</section>
<button type="button" class="wide" data-share-link="${h(link)}" data-share-text="${h(`Join me on ${settings.site_name}: what's happening around ${townOf(town)}, right now.`)}">${icon("send", { size: 18 })} Send my invite</button>
<button type="button" class="wide secondary" data-share-card='${h(JSON.stringify(spec))}'>Share as a picture</button>
<p class="small center" data-share-status hidden></p>
<p class="muted small center">${left} of ${invite.max_uses} invite${invite.max_uses === 1 ? "" : "s"} left <br><span class="mono mono-wrap">${h(link.replace(/^https?:\/\//, ""))}</span></p>`,
  });
}

module.exports = { townPicker, visitBanner, recapCard, todayPage, invitePage, townOf };
