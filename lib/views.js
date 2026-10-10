// The site's pages, as HTML. Built for phones first.

const { icon } = require("./icons");

const h = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const hidden = (token) => `<input type="hidden" name="_token" value="${h(token)}">`;
const errorBox = (error) => (error ? `<p class="error" role="alert">${h(error)}</p>` : "");
const noticeBox = (notice) => (notice ? `<p class="notice" role="status">${h(notice)}</p>` : "");

function avatar(user, size = "") {
  const label = h(user?.display_name || user?.username || "");
  if (user?.photo_key) return `<img class="avatar ${size}" src="/${h(user.photo_key)}" alt="${label}">`;
  const initial = h((user?.display_name || user?.username || "?").trim().charAt(0).toUpperCase());
  return `<span class="avatar placeholder ${size}" aria-label="${label}">${initial}</span>`;
}

const badge = (n) => (n ? `<b class="count">${n > 99 ? "99+" : n}</b>` : "");

function layout({ title, siteName, body, user = null, nav = "" }) {
  const counts = user?.badges || {};
  const tab = (name, href, label, glyph, count = 0) =>
    `<a href="${href}" class="${nav === name ? "on" : ""}" aria-label="${label}">${glyph}${badge(count)}<span>${label}</span></a>`;
  const bottomNav =
    user && user.username
      ? `<nav class="dock" aria-label="Main">
  ${tab("home", "/", "Home", icon("home"))}
  ${tab("messages", "/messages", "Messages", icon("chat"), counts.messages)}
  <a href="/new" class="dock-new${nav === "new" ? " on" : ""}" aria-label="New post">${icon("plus", { size: 26 })}</a>
  ${tab("activity", "/activity", "Activity", icon("bell"), counts.activity)}
  ${tab("profile", `/@${h(user.username)}`, "Profile", avatar(user, "tiny"))}
</nav>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#5b5fe0">
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/icon-180.png">
<link rel="manifest" href="/static/manifest.json">
<title>${h(title ? `${title} · ${siteName}` : siteName)}</title>
<link rel="preload" href="/static/fonts/jakarta.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/css/style.css">
<script src="/static/js/app.js" defer></script>
</head>
<body class="${user && user.username ? "with-nav" : ""}"${user && user.username && user.formToken ? ` data-token="${h(user.formToken)}"` : ""}>
<header class="top"><a class="brand" href="/"><img src="/static/icon.svg" alt="" width="28" height="28">${h(siteName)}</a>${user && user.username ? `<a class="top-link" href="/settings" aria-label="Settings">${icon("gear")}</a>` : ""}</header>
<main>
${body}
</main>
${bottomNav}
</body>
</html>`;
}

// ── Signed out ───────────────────────────────────────────────────────────

function landingPage({ settings }) {
  return layout({
    siteName: settings.site_name,
    body: `<section class="hero">
  <h1>${h(settings.tagline || "Your world. Happening now.")}</h1>
  <p class="lead">${h(settings.site_name)} introduces you to the people around you.</p>
  <p class="muted">Photos from people near you, and messages that disappear. Every profile is public; your exact location never is.</p>
  <a class="button wide" href="/sign-in">Sign in or join</a>
  ${settings.invite_only ? '<p class="muted small">We\'re in an invite-only beta. You\'ll need an invite code to join.</p>' : ""}
</section>
<footer class="foot"><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></footer>`,
  });
}

function signInPage({ settings, preToken, error = null, email = "" }) {
  return layout({
    title: "Sign in",
    siteName: settings.site_name,
    body: `<section class="card narrow">
  <h1>Sign in or join</h1>
  <p>We'll email you a 6-digit code. No password needed, and you'll stay signed in on this device.</p>
  ${errorBox(error)}
  <form method="post" action="/sign-in">
    ${hidden(preToken)}
    <label for="email">Email</label>
    <input type="email" id="email" name="email" required maxlength="200" autocomplete="email" value="${h(email)}">
    <button type="submit" class="wide">Email me a code</button>
  </form>
</section>`,
  });
}

function codePage({ settings, preToken, email, error = null }) {
  return layout({
    title: "Enter your code",
    siteName: settings.site_name,
    body: `<section class="card narrow">
  <h1>Check your email</h1>
  <p>We sent a 6-digit code to <strong>${h(email)}</strong>. It works for 10 minutes.</p>
  ${errorBox(error)}
  <form method="post" action="/sign-in/code">
    ${hidden(preToken)}
    <input type="hidden" name="email" value="${h(email)}">
    <label for="code">Code</label>
    <input type="text" id="code" name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" class="code">
    <button type="submit" class="wide">Sign in</button>
  </form>
  <p class="muted small"><a href="/sign-in">Use a different email</a></p>
</section>`,
  });
}

function welcomePage({ settings, user, formToken, values = {}, error = null, step = null }) {
  const teens = settings.teens_enabled;
  const askLocation = teens && settings.teen_states && settings.teen_states.length > 0;
  const consentUnder = teens ? settings.parental_consent_under || 0 : 0;
  return layout({
    title: "Welcome",
    siteName: settings.site_name,
    body: `<section class="card narrow">
  <h1>Welcome!</h1>
  <p>A few things to set up your profile.</p>
  ${errorBox(error)}
  <form method="post" action="/welcome" data-welcome data-consent-under="${consentUnder}" data-teen-location="${askLocation ? "yes" : ""}">
    ${hidden(formToken)}
    ${
      settings.invite_only
        ? `<label for="invite">Invite code</label>
    <input type="text" id="invite" name="invite" required maxlength="20" autocapitalize="characters" autocomplete="off" value="${h(values.invite)}">`
        : ""
    }
    <label for="birth_date">Date of birth</label>
    <input type="date" id="birth_date" name="birth_date" required value="${h(values.birth_date)}">
    <div class="hint">${
      teens
        ? `You need to be ${settings.teen_min_age} or older. We don't keep your birthday: for under-18s, only the day you turn 18.`
        : "You need to be 18 or older. We only keep that you are, not the date."
    }</div>
    ${
      consentUnder
        ? `<div data-parent${step === "parent" || values.parent_email ? "" : " hidden"}>
    <label for="parent_email">A parent's email</label>
    <input type="email" id="parent_email" name="parent_email" maxlength="200" value="${h(values.parent_email)}">
    <div class="hint">Under ${consentUnder}? We'll email them so they can OK your account.</div>
    </div>`
        : ""
    }
    ${askLocation ? `<input type="hidden" name="lat" value="${h(values.lat)}"><input type="hidden" name="lon" value="${h(values.lon)}">${step === "location" ? '<p class="small muted">Tap Join again and allow location when your phone asks.</p>' : ""}` : ""}
    <label for="username">Username</label>
    <div class="prefixed"><span>@</span><input type="text" id="username" name="username" required minlength="3" maxlength="30" pattern="[A-Za-z0-9_.]{3,30}" autocapitalize="none" autocomplete="username" value="${h(values.username)}"></div>
    <div class="hint">Letters, numbers, underscores and periods. Everyone can see it.</div>
    <label for="display_name">Name</label>
    <input type="text" id="display_name" name="display_name" required maxlength="50" autocomplete="name" value="${h(values.display_name)}">
    <div class="hint">Shown on your profile. It doesn't have to be your real name.</div>
    <label class="check"><input type="checkbox" name="terms"${values.terms === "on" ? " checked" : ""}> <span>I agree to the <a href="/terms" target="_blank">terms</a> and <a href="/privacy" target="_blank">privacy policy</a>.</span></label>
    <button type="submit" class="wide">Join</button>
  </form>
  <p class="muted small">Signed in as ${h(user.email)} · <a href="/sign-out-page">Sign out</a></p>
</section>`,
  });
}

function messagePage({ settings, user = null, title, message, extra = "" }) {
  return layout({
    title,
    siteName: settings.site_name,
    user,
    body: `<section class="card narrow"><h1>${h(title)}</h1><p>${h(message)}</p>${extra}<p><a href="/">Home</a></p></section>`,
  });
}

// ── Signed in ────────────────────────────────────────────────────────────

function settingsPage({ settings, user, formToken, error = null, notice = null, blockedList = [] }) {
  return layout({
    title: "Settings",
    siteName: settings.site_name,
    user,
    nav: "profile",
    body: `<h1>Settings</h1>
${errorBox(error)}${noticeBox(notice)}
<section class="card" id="profile">
  <h2>Profile</h2>
  <form method="post" action="/settings/profile">
    ${hidden(formToken)}
    <label for="display_name">Name</label>
    <input type="text" id="display_name" name="display_name" required maxlength="50" value="${h(user.display_name)}">
    <label for="username">Username</label>
    <div class="prefixed"><span>@</span><input type="text" id="username" name="username" required minlength="3" maxlength="30" autocapitalize="none" value="${h(user.username)}"></div>
    <label for="bio">Bio</label>
    <textarea id="bio" name="bio" maxlength="300" rows="3">${h(user.bio)}</textarea>
    <button type="submit">Save</button>
  </form>
</section>
<section class="card" id="photo">
  <h2>Profile photo</h2>
  <form method="post" action="/settings/photo?_token=${h(formToken)}" enctype="multipart/form-data" class="photo-pick" data-photo-form>
    <label class="avatar-pick">${avatar(user, "big")}<span class="avatar-cam">${icon("camera", { size: 18 })}</span>
      <input type="file" name="photo" accept="image/*" required aria-label="Choose a profile photo"></label>
    <div><strong>${user.photo_key ? "Change your photo" : "Add a photo"}</strong><div class="muted small">Tap your picture to take a new one or pick from your library.</div></div>
    <noscript><button type="submit" class="small">Upload</button></noscript>
  </form>
  ${user.photo_key ? `<form method="post" action="/settings/photo/remove">${hidden(formToken)}<button type="submit" class="link">Remove photo</button></form>` : ""}
</section>
<section class="card" id="area">
  <h2>Your area</h2>
  <p>${user.area_name ? `Your profile says <strong>${h(user.area_name)}</strong>.` : "Your profile doesn't show an area yet."} We use your phone's location, rounded to about a mile, to find the nearest town. Other people only ever see the town's name.</p>
  <form method="post" action="/settings/area" class="row" data-locate>
    ${hidden(formToken)}
    <input type="hidden" name="lat"><input type="hidden" name="lon">
    <button type="submit">Use my location</button>
  </form>
  <p class="error small" data-locate-error hidden></p>
  ${user.area_name ? `<form method="post" action="/settings/area/clear">${hidden(formToken)}<button type="submit" class="link">Don't show an area</button></form>` : ""}
</section>
<section class="card" id="blocked">
  <h2>Blocked</h2>
  ${
    blockedList.length
      ? `<ul class="blocked">${blockedList
          .map(
            (b) =>
              `<li>${avatar(b, "small")}<span class="grow">@${h(b.username)}</span><form method="post" action="/@${h(b.username)}/unblock">${hidden(formToken)}<input type="hidden" name="back" value="/settings"><button type="submit" class="small secondary">Unblock</button></form></li>`,
          )
          .join("")}</ul>`
      : '<p class="muted">Nobody. To block someone, open their profile and tap ⋯.</p>'
  }
</section>
<section class="card" id="account">
  <h2>Account</h2>
  <p class="muted">Signed in as ${h(user.email)}.</p>
  <form method="post" action="/sign-out">${hidden(formToken)}<button type="submit" class="secondary">Sign out</button></form>
  <form method="post" action="/sign-out/everywhere" class="spaced">${hidden(formToken)}<button type="submit" class="secondary">Sign out on all devices</button></form>
  <details class="spaced danger-zone">
    <summary>Delete my account</summary>
    <p>This removes your profile and everything you've posted. It can't be undone. (Anything already removed for breaking the rules is kept, as the privacy policy explains.)</p>
    <form method="post" action="/settings/delete">${hidden(formToken)}
      <label for="confirm">Type your username to confirm</label>
      <input type="text" id="confirm" name="confirm" autocapitalize="none" autocomplete="off" required>
      <button type="submit" class="danger">Delete my account</button>
    </form>
  </details>
</section>
<p class="muted small"><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p>`,
  });
}

function signOutPage({ settings, formToken }) {
  return layout({
    title: "Sign out",
    siteName: settings.site_name,
    body: `<section class="card narrow"><h1>Sign out?</h1><form method="post" action="/sign-out">${hidden(formToken)}<button type="submit" class="wide">Sign out</button></form></section>`,
  });
}

module.exports = {
  h,
  layout,
  avatar,
  landingPage,
  signInPage,
  codePage,
  welcomePage,
  messagePage,
  settingsPage,
  signOutPage,
};
