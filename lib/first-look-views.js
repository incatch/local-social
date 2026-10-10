// The first look (right after joining), the phone-notifications card, and
// Admin → New features.

const { h, layout, avatar } = require("./views");
const { icon } = require("./icons");
const { adminLayout } = require("./admin-views");
const { FEATURES, AUDIENCES } = require("./features");

const hidden = (token) => `<input type="hidden" name="_token" value="${h(token)}">`;
const townOf = (label) => String(label || "").split(",")[0];

/** Turn on phone notifications (the page's script decides what to show). */
function pushCard({ publicKey, compact = false }) {
  return `<section class="card push-card" data-push="${h(publicKey)}">
  <h2>${icon("bell", { size: 20 })} Phone notifications</h2>
  <p class="muted" data-push-status>${compact ? "Know the moment someone messages you or your post ripples." : "Get a buzz when someone messages you, comments, follows you, or your post ripples out. Never what a message says."}</p>
  <div class="row push-buttons">
    <button type="button" data-push-on>Turn on notifications</button>
    <button type="button" class="secondary small" data-push-test hidden>Send me a test</button>
    <button type="button" class="link small" data-push-off hidden>Turn off on this device</button>
  </div>
  <div class="ios-tip" data-push-ios hidden>
    <strong>On iPhone, one quick step first:</strong> tap the Share button <span class="share-glyph" aria-hidden="true">⬆︎</span> at the bottom of Safari, choose <strong>Add to Home Screen</strong>, then open Radius from your Home Screen and turn notifications on there.
  </div>
</section>`;
}

function personRow(p, formToken) {
  return `<li class="person">
  <a href="/@${h(p.username)}" class="person-link">${avatar(p, "small")}<span><strong>${h(p.display_name)}</strong><span class="muted small">@${h(p.username)}${p.area_name ? ` · ${h(townOf(p.area_name))}` : ""}</span></span></a>
  <form method="post" action="/@${h(p.username)}/follow">${hidden(formToken)}<input type="hidden" name="back" value="/hello"><button type="submit" class="small${p.followed ? " secondary" : ""}">${p.followed ? "Following" : "Follow"}</button></form>
</li>`;
}

/** The first thing a new member sees: it's alive here. */
function helloPage({ settings, user, formToken, town, peopleCount, best, people, publicKey }) {
  if (user.feed_lat === null) {
    return layout({
      title: "Welcome",
      siteName: settings.site_name,
      user,
      nav: "home",
      body: `<section class="hello-hero">
  <div class="rings-mark big" aria-hidden="true"><span></span><span></span><span></span></div>
  <h1>Welcome to ${h(settings.site_name)}, ${h(String(user.display_name).split(" ")[0])}!</h1>
  <p>${h(settings.site_name)} shows you what's happening around you, right now, from real people nearby.</p>
  <form method="post" action="/feed/location" data-locate>
    ${hidden(formToken)}<input type="hidden" name="lat"><input type="hidden" name="lon"><input type="hidden" name="back" value="/hello">
    <button type="submit" class="wide">${icon("pin", { size: 18 })} Show me what's around me</button>
  </form>
  <p class="error small" data-locate-error hidden></p>
  <p class="muted small">We round your location to about a mile. Nobody ever sees where you are.</p>
</section>`,
    });
  }
  const grid = best.length
    ? `<h2 class="section-title">The best of this week around ${h(townOf(town))}</h2>
<div class="grid hello-grid">${best.map((p) => `<a href="/p/${p.id}" class="cell"><img src="/${h(p.photos[0]?.thumb_key)}" alt="" loading="lazy">${p.like_count ? `<span class="cell-likes">${icon("heart", { size: 14, filled: true })} ${p.like_count}</span>` : ""}</a>`).join("")}</div>`
    : `<section class="card center"><p><strong>You're one of the first here.</strong> Share a photo of what's going on around you and you'll be the one everyone sees.</p><a class="button" href="/new">Share the first photo</a></section>`;
  return layout({
    title: "Welcome",
    siteName: settings.site_name,
    user,
    nav: "home",
    body: `<section class="hello-hero">
  <div class="rings-mark big" aria-hidden="true"><span></span><span></span><span></span></div>
  <p class="hello-count"><strong>${peopleCount}</strong> ${peopleCount === 1 ? "person" : "people"}</p>
  <h1>on ${h(settings.site_name)} within 10 miles of ${h(townOf(town) || "you")}</h1>
  ${peopleCount < 10 && settings.invites_per_member ? '<p class="muted">It gets better with every friend. <a href="/invite">Invite yours</a>.</p>' : ""}
</section>
${grid}
${people.length ? `<h2 class="section-title">People around you</h2><ul class="people">${people.map((p) => personRow(p, formToken)).join("")}</ul>` : ""}
${pushCard({ publicKey, compact: true })}
<p class="row hello-go"><a class="button wide" href="/?tab=nearby">Start exploring</a></p>
<p class="center"><a href="/new">Or share your first photo</a></p>`,
  });
}

function featuresPage({ settings, admin, notice }) {
  const rows = FEATURES.map(
    (f) => `<section class="card feature-row">
  <h2>${f.emoji} ${h(f.name)}</h2>
  <p>${h(f.what)}</p>
  <p class="muted small">Safety: ${h(f.guard)}</p>
  <div class="audience-pick" role="radiogroup" aria-label="${h(f.name)}">
    ${Object.entries(AUDIENCES)
      .map(([k, label]) => `<label><input type="radio" name="feature_${f.key}" value="${k}"${settings.features[f.key] === k ? " checked" : ""}><span>${label}</span></label>`)
      .join("")}
  </div>
</section>`,
  ).join("");
  return adminLayout({
    title: "New features",
    settings,
    admin,
    body: `<h1>New features</h1>
${notice ? `<p class="notice" role="status">${h(notice)}</p>` : ""}
<p>Choose who gets each new feature. <strong>18+ only</strong> hides it from teens (when teen mode is on). <strong>Everyone</strong> includes teens; please have the lawyer look at location features before choosing it.</p>
<form method="post" action="/admin/features">${hidden(admin.formToken)}
${rows}
<section class="card"><label for="heat_min_people">🔥 Where It's At lights up a spot when at least this many different people posted there</label>
<input type="number" id="heat_min_people" name="heat_min_people" min="2" max="20" value="${settings.heat_min_people}"></section>
<button type="submit">Save</button>
</form>`,
  });
}

module.exports = { helloPage, pushCard, featuresPage };
