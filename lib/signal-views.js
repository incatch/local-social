// Pages for Signals: the "Around you" bar on Nearby, the Around you page,
// one signal (with answers), and sending one.

const { h, layout, avatar } = require("./views");
const { ago } = require("./post-views");
const { icon } = require("./icons");
const { SIGNAL_KINDS } = require("./signal-store");

const hidden = (token) => `<input type="hidden" name="_token" value="${h(token)}">`;
const errorBox = (error) => (error ? `<p class="error" role="alert">${h(error)}</p>` : "");

/** "Today 6:00 PM", "Sat 6:00 PM" in the site's time zone. */
function planTime(at, timeZone) {
  const d = new Date(at);
  const day = (x) => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(d);
  if (day(d) === day(new Date())) return `Today ${time}`;
  if (day(d) === day(new Date(Date.now() + 86400000))) return `Tomorrow ${time}`;
  return `${new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(d)} ${time}`;
}

/** The slim bar on Nearby: easy to find, never in the way. */
function aroundBar(signals) {
  if (!signals.length) return `<a class="around-bar quiet" href="/around">${icon("ripple", { size: 16 })}<span>Around you: ask, plan, lost &amp; found, polls</span>${icon("next", { size: 16 })}</a>`;
  const first = signals[0];
  const counts = {};
  for (const s of signals) counts[s.kind] = (counts[s.kind] || 0) + 1;
  const summary = Object.entries(counts)
    .map(([k, n]) => `${SIGNAL_KINDS[k].emoji} ${n}`)
    .join(" · ");
  return `<a class="around-bar" href="/around">
  <span class="around-label">Around you</span>
  <span class="around-teaser">${SIGNAL_KINDS[first.kind].emoji} ${h(first.body.length > 54 ? `${first.body.slice(0, 54)}…` : first.body)}</span>
  <span class="around-counts">${summary}</span>
</a>`;
}

function pollBlock(s, formToken) {
  const votes = Object.fromEntries((s.votes || []).map((v) => [v.choice, v.n]));
  const total = Object.values(votes).reduce((a, b) => a + b, 0);
  const voted = s.my_vote !== null && s.my_vote !== undefined;
  return `<form method="post" action="/s/${s.id}/vote" class="poll">${hidden(formToken)}${(s.options || [])
    .map((o, i) => {
      const n = votes[i] || 0;
      const pct = total ? Math.round((n / total) * 100) : 0;
      return voted
        ? `<button type="submit" name="choice" value="${i}" class="poll-option done${s.my_vote === i ? " mine" : ""}"><span class="bar" style="width:${pct}%"></span><span>${h(o)}</span><b>${pct}%</b></button>`
        : `<button type="submit" name="choice" value="${i}" class="poll-option"><span>${h(o)}</span></button>`;
    })
    .join("")}<div class="muted small">${total} vote${total === 1 ? "" : "s"}</div></form>`;
}

function signalCard(s, { formToken, viewer, timeZone, full = false }) {
  const kind = SIGNAL_KINDS[s.kind];
  const mine = String(s.user_id) === String(viewer.id);
  let extra = "";
  if (s.kind === "plan") {
    extra = `<div class="plan-row"><span class="plan-time">${icon("bell", { size: 15 })} ${h(planTime(s.plan_at, timeZone))}</span>
      <form method="post" action="/s/${s.id}/join" class="inline" data-join>${hidden(formToken)}<button type="submit" class="small${s.joined ? " secondary" : ""}">${s.joined ? "✓ You're in" : "I'm in"}</button></form>
      <span class="muted small" data-join-count>${s.join_count} in</span></div>`;
  } else if (s.kind === "poll") {
    extra = pollBlock(s, formToken);
  }
  const replies =
    s.kind === "ask" || s.kind === "lost"
      ? `<a class="chip" href="/s/${s.id}#answers">${icon("comment", { size: 16 })}<span>${s.reply_count} ${s.kind === "ask" ? (s.reply_count === 1 ? "answer" : "answers") : s.reply_count === 1 ? "reply" : "replies"}</span></a>`
      : "";
  return `<article class="signal kind-${s.kind}">
  <header><span class="kind-badge">${kind.emoji} ${kind.label}</span><span class="muted small">${h(s.area_name || "")} · ${ago(s.created_at)}</span></header>
  <p class="signal-body">${h(s.body)}</p>
  ${extra}
  <footer>
    <a href="/@${h(s.username)}" class="who">${avatar({ username: s.username, display_name: s.display_name, photo_key: s.author_photo_key }, "tiny")}<span class="small">@${h(s.username)}</span></a>
    <span class="grow"></span>
    ${replies}
    ${full || s.kind === "ask" || s.kind === "lost" ? "" : `<a class="chip" href="/s/${s.id}">Open</a>`}
    ${mine ? "" : `<a class="chip more" href="/report?type=signal&amp;id=${s.id}" aria-label="Report">${icon("more", { size: 16 })}</a>`}
  </footer>
</article>`;
}

const FILTERS = [
  ["", "All"],
  ["ask", "❓ Questions"],
  ["plan", "🔥 Plans"],
  ["lost", "🐾 Lost & found"],
  ["poll", "📊 Polls"],
];

function aroundPage({ settings, user, formToken, signals, kind, timeZone }) {
  const chips = FILTERS.map(([k, label]) => `<a href="/around${k ? `?kind=${k}` : ""}" class="filter${(kind || "") === k ? " on" : ""}">${label}</a>`).join("");
  const empty =
    user.feed_lat === null
      ? `<section class="card center">Set your location on <a href="/?tab=nearby">Nearby</a> first, so we know what's around you.</section>`
      : `<section class="card center muted">Nothing here right now. Be the first: ask something, start a plan, or post a lost pet.</section>`;
  return layout({
    title: "Around you",
    siteName: settings.site_name,
    user,
    nav: "home",
    body: `<header class="around-head"><a href="/?tab=nearby" class="back" aria-label="Back">${icon("back")}</a><h1>Around you</h1></header>
<p class="muted small">Quick questions, plans and alerts for people within ${Math.max(user.feed_radius_miles, user.min_radius || 0)} miles. They disappear on their own.</p>
<div class="send-row"><span class="muted small">Send:</span>${Object.entries(SIGNAL_KINDS)
      .map(([k, v]) => `<a class="send-chip" href="/around/new?kind=${k}">+ ${v.label}</a>`)
      .join("")}</div>
<nav class="filters">${chips}</nav>
${signals.length ? signals.map((s) => signalCard(s, { formToken, viewer: user, timeZone })).join("") : empty}`,
  });
}

function signalPage({ settings, user, formToken, signal, replies, timeZone, error = null, extra = "" }) {
  const asker = String(signal.user_id) === String(user.id);
  const list = replies
    .map(
      (r) => `<li${r.thanked ? ' class="thanked"' : ""}>${avatar(r, "tiny")}<div class="grow"><a href="/@${h(r.username)}"><strong>${h(r.username)}</strong></a> ${h(r.body)}
  <div class="muted small">${ago(r.created_at)}${r.thanked ? " · 🙏 Thanked" : ""}${
    asker && !r.thanked && String(r.user_id) !== String(user.id)
      ? ` · <form method="post" action="/s/${signal.id}/thank/${r.id}" class="inline">${hidden(formToken)}<button type="submit" class="link small">🙏 Thanks</button></form>`
      : ""
  }</div></div></li>`,
    )
    .join("");
  const canReply = signal.kind === "ask" || signal.kind === "lost";
  return layout({
    title: SIGNAL_KINDS[signal.kind].label,
    siteName: settings.site_name,
    user,
    nav: "home",
    body: `<header class="around-head"><a href="/around" class="back" aria-label="Back">${icon("back")}</a><h1>${SIGNAL_KINDS[signal.kind].emoji} ${SIGNAL_KINDS[signal.kind].label}</h1></header>
${errorBox(error)}
${signalCard(signal, { formToken, viewer: user, timeZone, full: true })}
${extra}
${
  canReply
    ? `<section class="card" id="answers"><h2>${signal.kind === "ask" ? "Answers" : "Replies"}</h2>
  ${list ? `<ul class="replies">${list}</ul>` : `<p class="muted">No ${signal.kind === "ask" ? "answers" : "replies"} yet.</p>`}
  <form method="post" action="/s/${signal.id}/reply" class="comment-form">${hidden(formToken)}
    <textarea name="body" rows="2" maxlength="500" required placeholder="${signal.kind === "ask" ? "Know the answer?" : "Seen it? Say where and when."}" aria-label="Reply"></textarea>
    <button type="submit">Send</button>
  </form>
</section>`
    : ""
}
${asker ? `<form method="post" action="/s/${signal.id}/delete" onsubmit="return confirm('Delete this?')">${hidden(formToken)}<button type="submit" class="link small">Delete</button></form>` : ""}`,
  });
}

function newSignalPage({ settings, user, formToken, kind, values = {}, error = null }) {
  const k = SIGNAL_KINDS[kind] ? kind : "ask";
  const placeholders = {
    ask: "Anyone know why there are sirens on Glenstone?",
    plan: "Pickup basketball at Phelps Grove, need 2 more",
    lost: "Lost: grey cat, blue collar, near Battlefield & National",
    poll: "Best tacos in town?",
  };
  const tabs = Object.entries(SIGNAL_KINDS)
    .map(([key, v]) => `<a href="/around/new?kind=${key}" class="filter${key === k ? " on" : ""}">${v.emoji} ${v.label}</a>`)
    .join("");
  return layout({
    title: SIGNAL_KINDS[k].label,
    siteName: settings.site_name,
    user,
    nav: "new",
    body: `<header class="around-head"><a href="/around" class="back" aria-label="Back">${icon("back")}</a><h1>Send to people around you</h1></header>
<nav class="filters">${tabs}</nav>
${errorBox(error)}
<form method="post" action="/around/new" class="card" data-signal>${hidden(formToken)}<input type="hidden" name="kind" value="${k}">
  <textarea name="body" rows="3" maxlength="280" required placeholder="${h(placeholders[k])}" aria-label="Message">${h(values.body)}</textarea>
  ${
    k === "plan"
      ? `<label for="plan_at">When</label><input type="datetime-local" id="plan_at" name="plan_at" required value="${h(values.plan_at)}"><input type="hidden" name="plan_at_iso">`
      : ""
  }
  ${
    k === "poll"
      ? `<label>Choices</label>${[0, 1, 2, 3].map((i) => `<input type="text" name="option${i}" maxlength="60" placeholder="${i < 2 ? `Choice ${i + 1}` : `Choice ${i + 1} (optional)`}" value="${h(values[`option${i}`])}"${i < 2 ? " required" : ""} class="poll-input">`).join("")}`
      : ""
  }
  <p class="muted small">Goes to people within ${Math.max(user.feed_radius_miles, user.min_radius || 0)} miles of your Nearby spot${user.area_name ? ` (${h(user.area_name)})` : ""}. ${
    k === "plan" ? "It disappears 2 hours after the time you pick." : k === "lost" ? "It stays up for 3 days." : "It disappears after a day."
  }</p>
  <button type="submit" class="wide">Send</button>
</form>`,
  });
}

module.exports = { aroundBar, aroundPage, signalPage, newSignalPage, signalCard, planTime };
