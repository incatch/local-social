// The terms and privacy policy. Plain-English drafts: the owner should have
// a lawyer review them before the site opens to the public.

const { layout } = require("./views");

/** Teen mode, as the terms and privacy policy describe it (when it's on). */
function teenTerms(settings) {
  if (!settings.teens_enabled) return "<p>You must be 18 or older. One account per person. Don't pretend to be someone else.</p>";
  const { teenRulesList } = require("./teen-views");
  return `<p>You must be ${settings.teen_min_age} or older${settings.teen_states.length ? ` (under-18s only in ${settings.teen_states.join(", ")})` : ""}. One account per person. Don't pretend to be someone else, and don't lie about your age.</p>
<p><strong>Under 18:</strong> you're in a separate, teens-only part of ${settings.site_name}.${settings.parental_consent_under ? ` If you're under ${settings.parental_consent_under}, a parent has to OK your account first.` : ""}</p>
${teenRulesList(settings)}
<p>Adults may not try to contact teens on ${settings.site_name}, or teens adults. Accounts that do are closed.</p>`;
}

const DRAFT = `<p class="notice">Draft for the invite-only beta. To be reviewed by a lawyer before the site opens to the public.</p>`;

function termsPage({ settings, user }) {
  const site = settings.site_name;
  return layout({
    title: "Terms",
    siteName: site,
    user,
    body: `<article class="card legal">
<h1>Terms of use</h1>
${DRAFT}
<h2>Who can use ${site}</h2>
${teenTerms(settings)}
<h2>Everything you post is public</h2>
<p>Profiles and posts can be seen by everyone using ${site}, along with the town you posted from. Don't post anything you wouldn't want people near you to see.</p>
<h2>Nearby is real, local and not political</h2>
<p>Nearby is for what's happening around you, so these aren't shown there (your followers still see them on your profile and in Following):</p>
<ul>
<li>Posts that look political: in the caption, in text in the photo, or showing a political figure.</li>
<li>Photos made with AI. Don't present AI-made or AI-edited photos as real places or moments.</li>
</ul>
<p>Photos the camera says were taken recently, right where they were posted, get a "Taken here" mark. We compare the camera's time and place with the post's and then throw them away; we never keep them.</p>
<h2>What isn't allowed</h2>
<ul>
<li>Nudity or sexual content of any kind. (Swimwear is fine, thongs included.)</li>
<li>Anything sexual involving anyone under 18. We report it to the National Center for Missing &amp; Exploited Children and to the police.</li>
<li>Threats, harassment, bullying, hate against people for who they are, or encouraging violence or self-harm.</li>
<li>Sharing someone's private information (where they live, their phone number) or photos of people who haven't agreed to it in private settings.</li>
<li>Illegal goods or services, scams, spam, and fake accounts.</li>
<li>Other people's photos or work that you don't have the right to share.</li>
</ul>
<h2>How we keep it safe</h2>
<p>Every photo is checked automatically before anyone sees it, and people can report posts, comments, messages and profiles, and block anyone. Posts reported by several people are hidden until they're reviewed. We may remove content, warn, or close accounts that break these rules, at our discretion.</p>
<h2>Your content</h2>
<p>You own what you post. By posting, you let ${site} show it on the site and store it to run the service. Content removed for breaking the rules may be kept and used to improve our moderation (see the privacy policy).</p>
<h2>Messages</h2>
<p>Photos sent in messages can be viewed once and chat messages disappear after they're read, but anyone you send something to can still photograph their screen. Don't send anything you'd regret.</p>
<h2>No guarantees</h2>
<p>${site} is provided as it is. We may change or stop it, and we're not responsible for what other people post or do.</p>
<p class="muted small">Questions or reports: use the report buttons on the site.</p>
</article>`,
  });
}

function privacyPage({ settings, user }) {
  const site = settings.site_name;
  return layout({
    title: "Privacy",
    siteName: site,
    user,
    body: `<article class="card legal">
<h1>Privacy policy</h1>
${DRAFT}
<h2>What we keep</h2>
<ul>
<li><strong>Your email</strong>, to send sign-in codes. It's never shown to anyone.</li>
<li><strong>Your profile</strong>: username, name, bio and photo. Public.</li>
<li><strong>Your age group.</strong> We check your date of birth when you join but don't keep it: only that you're 18 or older${settings.teens_enabled ? ", or, if you're under 18, the day you turn 18 (when your account becomes an adult one)" : ""}.</li>
${settings.teens_enabled && settings.parental_consent_under ? `<li><strong>A parent's email</strong>, for teens under ${settings.parental_consent_under}, to ask for their OK. We don't email them anything else.</li>` : ""}
<li><strong>Your area.</strong> When you use your location, it's rounded to about a mile before it's used, and only the nearest town's name is ever shown. We never keep or show your exact location. We look up the town on our own servers; your location isn't sent to other companies.</li>
<li><strong>Your photos</strong>, with the hidden data phones add (including the exact place a photo was taken) removed before they're stored.</li>
</ul>
<h2>Messages</h2>
<p>Messages are encrypted when sent and stored, and deleted on schedule: photos an hour after they've been viewed (so the person who saw one can report it), chat messages 24 hours after they're read, unless both people choose to save them. If you report a message or photo, a copy goes to the site's owner with your report. They aren't end-to-end encrypted, so they could be seen by us if reported or required by law.</p>
<h2>Moderation</h2>
<p>Photos are checked automatically (by Amazon's image-checking service) for nudity and violence before anyone sees them. <strong>Anything removed for breaking the rules is kept</strong>, together with why it was removed, in a private area only the site's owner can see. It may be used to train our own moderation tools. This applies even to view-once photos and survives deleting your account. Material involving the abuse of children is never used for this; it is reported to the National Center for Missing &amp; Exploited Children and kept only as the law requires.</p>
<h2>Deleting your account</h2>
<p>Settings → Delete my account removes your profile and posts straight away (except content removed for breaking the rules, as above).</p>
<h2>Sharing</h2>
<p>We don't sell your information or show you ads based on it. We share it only with the services that run the site (Amazon Web Services for hosting, email and image checks) or when the law requires.</p>
<p class="muted small">Town names: GeoNames (geonames.org), CC BY 4.0.</p>
</article>`,
  });
}

module.exports = { termsPage, privacyPage };
