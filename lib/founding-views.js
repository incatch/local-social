// Admin cards for founding members: open sign-ups for the first 500, and the waitlist.

const { h } = require("./views");
const { when } = require("./admin-views");

const hidden = (token) => `<input type="hidden" name="_token" value="${h(token)}">`;

function foundingCard({ settings, admin, founding, waiting, siteUrl }) {
  const pct = Math.min(100, Math.round((founding.members / founding.limit) * 100));
  return `<section class="card" id="founding">
  <h2>🌱 Founding members</h2>
  <p><strong>${founding.members} of ${founding.limit}</strong> founding spots taken · ${founding.left} left</p>
  <div class="meter" role="img" aria-label="${pct}% of founding spots taken"><span style="width:${pct}%"></span></div>
  <p class="muted small">${
    founding.open
      ? `<strong>Open:</strong> anyone can join without an invite until ${founding.limit} people have. Then it goes back to invite only, and the front page offers the waitlist.`
      : settings.founding_open
        ? "<strong>Full.</strong> New people join the waitlist (Invites) or need an invite."
        : "<strong>Closed:</strong> new people need an invite code (or join the waitlist)."
  }</p>
  <form method="post" action="/admin/founding">${hidden(admin.formToken)}
    <label class="check"><input type="checkbox" name="founding_open"${settings.founding_open ? " checked" : ""}> <span>Let people join without an invite until the founding spots are full</span></label>
    <label for="founding_limit">Founding spots</label>
    <input type="number" id="founding_limit" name="founding_limit" min="1" max="100000" value="${settings.founding_limit}" style="max-width:8em">
    <label for="founding_area">Town name on the front page</label>
    <input type="text" id="founding_area" name="founding_area" maxlength="40" value="${h(settings.founding_area)}" style="max-width:16em">
    <button type="submit">Save</button>
  </form>
  <p class="muted small">Ads: link to <span class="mono">${h(siteUrl)}/?utm_source=instagram&amp;utm_campaign=springfield</span> (change the words to match each ad). Admin → Beta shows how many people each one brought. ${waiting ? `<a href="/admin/invites#waitlist">${waiting} on the waitlist</a>.` : ""}</p>
</section>`;
}

function waitlistCard({ admin, list, timeZone }) {
  const rows = list
    .map(
      (w) => `<tr><td>${h(w.email)}</td><td class="small">${h(w.source || "")}</td><td class="small">${h(when(w.created_at, timeZone))}</td>
  <td><form method="post" action="/admin/waitlist/${w.id}/invite">${hidden(admin.formToken)}<button type="submit" class="small">Send invite</button></form></td></tr>`,
    )
    .join("");
  return `<section class="card" id="waitlist">
  <h2>Waitlist (${list.length})</h2>
  <p class="muted small">People who asked to join once the founding spots were full. "Send invite" emails them a one-time invite link.</p>
  ${rows ? `<div class="table-wrap"><table><tr><th>Email</th><th>From</th><th>Joined the list</th><th></th></tr>${rows}</table></div>` : '<p class="muted">Nobody waiting.</p>'}
</section>`;
}

module.exports = { foundingCard, waitlistCard };
