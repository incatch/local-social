// Drops (posts you have to go to) and Where It's At (the map that glows).

const { h, layout } = require("./views");
const { icon } = require("./icons");
const { ago } = require("./post-views");

const hidden = (token) => `<input type="hidden" name="_token" value="${h(token)}">`;
const errorBox = (error) => (error ? `<p class="error" role="alert">${h(error)}</p>` : "");
const EMOJI = { park: "🌳", playground: "🛝", cafe: "☕", restaurant: "🍽️", library: "📚", artwork: "🎨", viewpoint: "🌄", museum: "🏛️", shop: "🛍️", historic: "🏛️", fountain: "⛲", skatepark: "🛹" };
const emojiOf = (kind) => EMOJI[kind] || "📍";
const leftWhen = (t) => {
  const a = ago(t);
  return a === "now" ? "just now" : /\d[mhd]$/.test(a) ? `${a} ago` : `on ${a}`;
};

/** The chips on Nearby that lead to the new things. */
function discoverRow({ drops = null, where = false }) {
  const chips = [];
  if (where) chips.push('<a class="discover-chip hot" href="/where">🔥 Where it\'s at</a>');
  if (drops !== null) chips.push(`<a class="discover-chip" href="/drops">📍 Drops${drops ? ` <b>${drops}</b>` : ""}</a>`);
  return chips.length ? `<nav class="discover-row" aria-label="Discover">${chips.join("")}</nav>` : "";
}

function dropsPage({ settings, user, formToken, nearby, mine, stamps, notice = null }) {
  const radar = nearby.length
    ? `<ul class="drop-list" data-radar>${nearby
        .map(
          (d) => `<li class="${d.found ? "found" : ""}" data-lat="${d.lat}" data-lon="${d.lon}">
  <a href="/drops/${d.id}"><span class="drop-pin">${d.found ? "✅" : emojiOf(d.place_kind)}</span>
  <span class="grow"><strong>${h(d.place_name)}</strong><span class="muted small">${d.found ? "Found it" : `Left ${leftWhen(d.created_at)}`}${d.finds ? ` · found by ${d.finds}` : ""}</span></span>
  <span class="drop-heat" data-heat>${d.miles < 0.1 ? "here" : `${d.miles < 1 ? d.miles.toFixed(1) : Math.round(d.miles)} mi`}</span></a>
</li>`,
        )
        .join("")}</ul>
<p class="muted small center" data-radar-status>Turn on location for hot and cold as you walk.</p>`
    : `<section class="card center"><p><strong>No Drops around you yet.</strong></p><p class="muted">Be the first: leave a photo or a note at a park, a mural, a café. Whoever gets there finds it.</p></section>`;
  return layout({
    title: "Drops",
    siteName: settings.site_name,
    user,
    nav: "home",
    body: `<header class="around-head"><a href="/?tab=nearby" class="back" aria-label="Back">${icon("back")}</a><h1>📍 Drops</h1></header>
<p class="muted">Photos and notes left at real places. You can only open one when you get there.</p>
${notice ? `<p class="notice" role="status">${h(notice)}</p>` : ""}
<p><a class="button wide" href="/drops/new">📍 Leave a Drop here</a></p>
${radar}
${
  mine.length
    ? `<h2 class="section-title">Your Drops</h2><ul class="drop-list">${mine
        .map((d) => `<li><a href="/drops/${d.id}"><span class="drop-pin">${emojiOf(d.place_kind)}</span><span class="grow"><strong>${h(d.place_name)}</strong><span class="muted small">Found by ${d.finds} ${d.finds === 1 ? "person" : "people"}</span></span></a></li>`)
        .join("")}</ul>`
    : ""
}
${
  stamps.length
    ? `<h2 class="section-title">Your stamps · ${stamps.length} found</h2><div class="stamps">${stamps
        .map((s) => `<a class="stamp" href="/drops/${s.id}" title="${h(s.place_name)}"><span>${emojiOf(s.place_kind)}</span><small>${h(s.place_name)}</small></a>`)
        .join("")}</div>`
    : ""
}`,
  });
}

function newDropPage({ settings, user, formToken, error = null }) {
  return layout({
    title: "Leave a Drop",
    siteName: settings.site_name,
    user,
    nav: "new",
    body: `<header class="around-head"><a href="/drops" class="back" aria-label="Back">${icon("back")}</a><h1>Leave a Drop</h1></header>
<p class="muted">Drops go at public places, like parks, landmarks, murals and cafés, never homes or schools. Anyone who gets there can open it.</p>
${errorBox(error)}
<form method="post" action="/drops/new?_token=${h(formToken)}" enctype="multipart/form-data" class="card" data-drop-form>
  <input type="hidden" name="lat"><input type="hidden" name="lon">
  <div data-spot-step>
    <button type="button" class="wide" data-find-spots>${icon("pin", { size: 18 })} Find public places around me</button>
    <p class="muted small center" data-spot-status></p>
    <div class="spot-list" data-spot-list></div>
  </div>
  <div data-drop-step hidden>
    <label class="photo-drop">${icon("camera", { size: 22 })}<span>Add a photo (optional)</span><input type="file" name="photo" accept="image/*" hidden></label>
    <label for="drop-note">A note for whoever finds it</label>
    <textarea id="drop-note" name="note" rows="2" maxlength="140" placeholder="Best view in town. Come back at sunset 🌅"></textarea>
    <button type="submit" class="wide">Leave it here</button>
    <p class="muted small">It stays for 30 days. Nobody sees who opened it.</p>
  </div>
</form>`,
  });
}

function dropPage({ settings, user, formToken, drop, error = null }) {
  const own = String(drop.user_id) === String(user.id);
  const open = own || drop.found;
  return layout({
    title: drop.place_name,
    siteName: settings.site_name,
    user,
    nav: "home",
    body: `<header class="around-head"><a href="/drops" class="back" aria-label="Back">${icon("back")}</a><h1>${emojiOf(drop.place_kind)} ${h(drop.place_name)}</h1></header>
${errorBox(error)}
${
  open
    ? `<section class="card drop-open">
  ${drop.found && !own ? '<p class="found-stamp">✅ Found it</p>' : ""}
  ${drop.photo_key ? `<img src="/${h(drop.photo_key)}" alt="" class="drop-photo">` : ""}
  ${drop.note ? `<p class="drop-note">“${h(drop.note)}”</p>` : ""}
  <p class="muted small">Left by <a href="/@${h(drop.username)}">@${h(drop.username)}</a> ${leftWhen(drop.created_at)} · found by ${drop.finds} ${drop.finds === 1 ? "person" : "people"}</p>
  ${own ? `<form method="post" action="/drops/${drop.id}/delete" onsubmit="return confirm('Delete this Drop?')">${hidden(formToken)}<button type="submit" class="link small">Delete</button></form>` : `<a class="muted small" href="/report?type=user&amp;id=${h(drop.username)}">Report</a>`}
</section>`
    : `<section class="card drop-locked center" data-lat="${drop.lat}" data-lon="${drop.lon}">
  <p class="lock">🔒</p>
  <p><strong>Something's waiting here.</strong></p>
  <p class="muted">Get to ${h(drop.place_name)} to open it.</p>
  <p class="drop-heat big" data-heat></p>
  <form method="post" action="/drops/${drop.id}/open" data-locate="precise">${hidden(formToken)}<input type="hidden" name="lat"><input type="hidden" name="lon"><button type="submit" class="wide">I'm here, open it</button></form>
  <p class="error small" data-locate-error hidden></p>
  <p class="small"><a href="https://www.openstreetmap.org/?mlat=${drop.lat}&amp;mlon=${drop.lon}#map=18/${drop.lat}/${drop.lon}" target="_blank" rel="noopener">Show it on a map</a></p>
</section>`
}`,
  });
}

function wherePage({ settings, user, lat, lon }) {
  return layout({
    title: "Where it's at",
    siteName: settings.site_name,
    user,
    nav: "home",
    body: `<link rel="stylesheet" href="/static/vendor/leaflet.css"><script src="/static/vendor/leaflet.js"></script>
<header class="around-head"><a href="/?tab=nearby" class="back" aria-label="Back">${icon("back")}</a><h1>🔥 Where it's at</h1></header>
<p class="muted small">Glowing where lots of different people posted in the last few hours. It's always at least 30 minutes behind and about a mile wide, so nobody can be followed.</p>
<div class="where-map" data-where-map data-lat="${lat}" data-lon="${lon}"></div>
<p class="muted small center" data-where-status>Loading…</p>
<div class="where-list" data-where-list></div>`,
  });
}

module.exports = { discoverRow, dropsPage, newDropPage, dropPage, wherePage, emojiOf };
