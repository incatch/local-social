# Radius

*Your world. Happening now.*

Instagram shows you people you know. Radius introduces you to the people
around you: Instagram-style posts and a feed of what's happening near you,
with disappearing messages and view-once photos. Every profile is public; nobody's exact location
ever is. Live at https://social.plopza.com (invite-only beta).

## Being built in four parts

1. **Accounts and profiles** (done): sign in with an emailed code
   (stays signed in on each device), invite codes during the beta, 18+ only,
   username, name, bio, profile photo, and your area.
2. **Posts and feeds** (done): photos and carousels of up to 10, captions,
   likes, comments, @mentions, follows; a Nearby feed (5/10/25/50 miles from
   your latest rounded location, newest first with a light boost for likes)
   and a Following feed; profile grids. Photos are shrunk in the browser
   before uploading, then re-encoded on the server (full size and a square
   thumbnail).
3. **Messages and view-once photos** (done): one-to-one chats from a profile's Message
   button. A first message to someone who doesn't follow you is a message
   request (up to 3 texts, no photos, until they accept or reply; they can
   delete it). View-once photos open once and the photo is deleted as it's shown. Read
   messages disappear 24 hours after they're read unless both people keep
   the chat; unread ones after 30 days. Unsend, "Seen", new messages appear
   without reloading. Activity page for likes, comments, follows and
   @mentions, with badges on the bottom bar. The app icon and "Add to Home
   Screen" support.
4. **Safety** (done): report posts, comments, messages, view-once photos and people
   (private; posts reported by 3 people, or once for anything involving a
   minor, are hidden until reviewed); block (no profiles, posts, comments or
   messages either way); every photo screened by Amazon Rekognition before
   anyone sees it (explicit: refused; borderline: held for review); the
   Admin → Moderation queue (keep, remove, ban, legal hold) with email
   alerts; Admin → Removed, the moderated-out store (labels, report reasons
   and decisions, for training a moderation model later). Anything involving
   a minor goes to legal hold: locked away, never shown or used for
   training, account banned, and the owner reports it to NCMEC.

   **Before opening to the public:** add an abuse-image hash check (e.g.
   Microsoft PhotoDNA or Thorn Safer, which need an application) and have a
   lawyer review the terms, privacy policy and NCMEC reporting process.

## No politics on Nearby

Posts that look political stay off the Nearby feed (followers still see
them on the profile and in Following; the poster is told). A post counts as
political if its caption or the text in its photos (read by Rekognition)
uses a word from the list, or its photos show a political figure
(recognised by Rekognition, then checked on Wikidata: politician, political
office or party member; looked up once per person). Admin → Nearby rules:
turn it on/off, edit the words and extra names (saving re-checks the last
30 days), and "Show on Nearby anyway" for mistakes.

## Ripples and the end of the feed

A new post reaches people within 10 miles; at 3 likes + comments it ripples
to 25 miles, at 10 to 50 (Admin → Nearby rules), and the poster gets an
Activity note each time it reaches a new ring. Nearby shows the last 14
days, says "N new since you last looked", and ends with "You're all caught
up" (no endless scroll) and "Around here, a year ago": photos from this
week in past years.

## Moments

When 3 different people post within 1 mile of each other within 3 hours
(Admin → Nearby rules), their posts become a Moment, a shared album titled
like "Friday night in Springfield". Later posts from the same spot while it's
going on join it. Moments show at the top of Nearby ("Happening now"), each
post in one links to it, and the posters get an Activity note. Political and
AI-made posts don't join; each viewer only sees what they're allowed to.

## Around you (signals)

Quick text posts to people within your Nearby distance that disappear on
their own: ❓ Ask (neighbours answer; the asker can 🙏 thank the best one),
🔥 Plan (a time and "I'm in"; gone 2 hours after), 🐾 Lost & found (3 days)
and 📊 Poll (2–4 choices, a day). Easy to find but never in the way: one
slim "Around you" bar on Nearby, a small row on the + page, and the Around
you page. No politics; reportable; blocks and teen mode apply. On/off in
Admin → Nearby rules.

## Growth

- **Visit another town**: tap the town chip on Nearby: update to where you
  are, tap a nearby town to peek at, or type any town (suggestions as you
  type). Read-only, with a "Back home" banner.
- **Today in <town>**: each evening (5pm+, with 3+ local photos) a card on
  Nearby opens a recap; "Share" draws a 1080×1920 story picture on the phone
  (with the Radius mark) and opens the phone's share sheet.
- **Invite cards**: every member has one at /invite (QR code, "Sam invited
  you to Radius · Springfield · 31 people nearby"), shared as a link or a
  picture; each brings in up to 5 people (Admin → Nearby rules; 0 = off).

## Local badges

Earned by being real and out in town, never by follower counts: 🌱 Founding
member (the first 500, a setting), 📍 Local (5 "Taken here" photos), ⭐ Regular (7 days in a
month), 🌅 Early bird, 🌙 Night owl, 🧭 Explorer (5 towns), 🎉 In the moment
(3 Moments), 🤝 Good neighbor (3 thanked answers), 🔥 Organizer (a plan 3
people join), 🌊 Ripple maker. Shown on profiles; /badges explains them;
an Activity note when one is earned. Rules in `lib/badges.js`; switch in
Admin → Nearby rules.

## Beta polish

- **Find people:** the magnifying glass at the top of every page. Search by
  name or @username (results update as you type; follow right from the
  list). Before typing, it shows people around you that you don't follow
  yet. Only people you're allowed to see show up (blocks, teen mode).
- **Feedback:** "Send feedback" in Settings and on your own profile. Pick
  Idea / Something's wrong / Something else, write a note. It lands in
  Admin → Beta (with the page they were on and their device), and the
  owner gets an email (at most one every 15 minutes).
- **Email nudges** (`lib/nudges.js`, every 10 minutes): an email when
  messages have waited an hour unread (at most one a day, only for new
  messages, never what they say), and a weekly "N new posts around
  <town>" for people away 3+ days, only when there's something new. Every
  email has a one-tap "turn them off" link; people can also switch them in
  Settings → Emails, and the owner can switch them all off in Admin → Beta.
- **Admin → Beta:** members; who was here today / this week / this month;
  how many came back after day one and are still here after a week; how
  many joined from a friend's invite; the last 14 days (here, joined, posts,
  comments, messages, Around you, emails); the busiest towns; feedback.

## First look and phone notifications

- **First look** (`/hello`, right after joining): "31 people on Radius
  within 10 miles of Springfield", the best photos of the week around
  them, people to follow, and turning on notifications. If we don't know
  where they are yet, one button asks.
- **Phone notifications** (`lib/push.js`, web push): likes, comments,
  follows, mentions, answers, Moments, ripples, badges and messages buzz
  the phone. Never what a message says. Works on Android and computers in
  the browser, and on iPhone once Radius is added to the Home Screen (the
  card explains how). Turn on in Settings, the first look, or the top of
  Activity. Sent every 5 seconds by `server.js`; each is claimed in the
  database first so it's sent once. The push keys are worked out from the
  site's secret, so there's nothing extra to set up.

## New features: Off, 18+ only or Everyone

Admin → New features sets who gets Pull Up, Squads, Drops, Where It's At
and video/Moment Reels (`lib/features.js`). They start as 18+ only; check
with `featureOn(settings, key, user)` wherever one shows up.

## Pull Up and Squads

- **Pull Up** (posts with a place, for a day; plans until they end): tap
  🙋 Pull up ("on my way", the poster hears about it), then "I'm here 👋"
  once you're within about a mile (checked once, never tracked), and add
  a quick selfie (screened like any photo) to the post's Pull Up wall.
- **Squads** (`/squads`, from Messages and your profile): up to 8 friends
  who follow each other. A squad chat (messages go after 7 days) and a
  weekly 🔥 streak that only grows when the squad does something real
  together that week (Monday to Sunday, site time): posts from the same
  spot within 2 hours, the same plan, pulling up together or to a
  squadmate's post, or the same Moment. Everyone hears when the streak
  grows, and on the weekend if it's about to end. Rules in
  `lib/irl-store.js`.

## Drops and Where It's At

- **Drops** (`/drops`, a chip on Nearby): leave a photo or a note at a
  public place you're at. The page looks up public places within ~150 m
  from OpenStreetMap's free Overpass service (`lib/public-places.js`,
  remembered 30 days): parks, landmarks, murals, cafés, shops; never bars,
  and never within 250 m of a school. The Drop is saved at the place's own
  map position (never where the person stood). Others see a list with
  hot-and-cold distances as they walk, and can only open it from within
  ~200 m (the phone's exact position is checked once and never stored).
  The person who left it hears "someone found your Drop", never who.
  "Found it" stamps; up to 5 live Drops each, for 30 days.
- **Where It's At** (`/where`): a map (Leaflet + OpenStreetMap tiles) that
  glows where at least 3 different adults (Admin → New features) posted
  in the last 3 hours, always at least 30 minutes behind, on the
  mile-wide rounded spots. Teens' posts never count.

## Video clips and Moment Reels

- **Clips** (`lib/video.js`, needs ffmpeg: installed in the container, and
  `ffmpeg-static` for tests): posts can mix photos and short clips. Each
  clip is cut to 15 seconds, made silent (no music rights, no overheard
  voices), shrunk to 720p, stripped of hidden data, and every second of it
  goes through photo screening. Phones play them on a loop in the feed.
- **Moment Reels** (`lib/reels.js`, `lib/beats.js`): a ~15–20 second
  vertical video of a Moment: a title card, each photo with a slow zoom or
  clip, and a "made with Radius" end card, cut to a beat Radius makes
  itself (three moods; each Moment always gets the same one). Anyone can
  tap "Make the Moment Reel"; and when a Moment ends (45 minutes after its
  last post), everyone who posted in it gets theirs and a notification.
  A reel only uses posts that person may see. Share sends the video file
  straight to the phone's share sheet; Save downloads it.
- The site now runs on 0.5 vCPU / 2 GB to make room for video.

## Founding members (the first 500)

For the launch ad campaign in Springfield. Admin → Overview → Founding
members: switch on "let people join without an invite" and anyone can
join until 500 people have (the number and the town's name are
settings). The front page counts down the spots left; each new member
sees "You're founding member #37 of 500"; the first 500 get the 🌱
Founding member badge. When the spots are full it goes back to invite
only by itself and the front page (and the join page) offer a waitlist;
Admin → Invites lists it with a "Send invite" button that emails a
one-time invite.

Ads: link to `/?utm_source=instagram&utm_campaign=springfield` (any
words). The site remembers where each person first came from (30 days)
and Admin → Beta shows members per ad.

## Real photos on Nearby

Photos that say they were made with AI (content credentials / IPTC
"trainedAlgorithmicMedia", or an image generator's own label) stay off
Nearby; followers still see them, and the poster is told. Photos whose
camera record says they were taken recently, close to where they were
posted, get a "Taken here" badge. The browser sends the start of each
original file (shrinking drops this data); the server reads it and throws
it away (`lib/provenance.js`). "Fake or AI-made photo" is a report reason;
the owner can keep a reported post up but off Nearby. Admin → Nearby rules
has the switches, the badge's time and distance, and "Show on Nearby
anyway". A paid AI-image detector (Sightengine, Hive) can be added later
for images with no label.

## Teen mode (off until the owner turns it on)

Admin → Teen mode lets 13–17-year-olds join, in a world of their own:
adults and teens can never see, find or message each other (one database
function, `can_interact`, decides this everywhere, along with blocks). At 18
an account becomes an adult one automatically. Settings, no code changes:

- youngest age (13–17); US states where teens may join (they share their
  rounded location once at sign-up; it also fills in their town);
- a parent's OK by email for teens under a chosen age (the teen waits until
  the parent clicks yes; no deletes the account);
- who teens can message (mutual follows / followers / requests), view-once
  photos (off / mutual follows / on), stricter photo screening (swimwear and
  partial nudity held), distances on Nearby, and the smallest Nearby radius.

We keep no birthday: for under-18s only the day they turn 18. The terms
and privacy policy change with the settings. **Before turning it on:** a
lawyer's OK (state laws change often), and later an age-estimation service
(e.g. Yoti or Persona) if the laws where teens are allowed require it.

## Privacy rules the code keeps

- **Location**: the phone's location is rounded to a ~1 mile grid before
  it's used or saved (`lib/places.js`); people only ever see the nearest
  town's name, looked up on our own server (GeoNames data, CC BY 4.0).
- **Photos**: every upload is re-encoded (`lib/images.js`), which strips the
  hidden EXIF data, including the GPS spot it was taken.
- **Age**: date of birth is checked (18+) at sign-up but not stored.

## Admin

https://social.plopza.com/admin (household sign-in): who has joined, ban and
unban, invites (with join links), opening sign-ups to everyone, the
moderation queue, Nearby rules, Teen mode, and Beta (how the beta is going,
feedback, email nudges).

## Running it on your computer

Needs Node.js 22 and PostgreSQL.

    npm install
    DATABASE_URL=postgres://postgres@localhost/social SESSION_SECRET=$(openssl rand -hex 32) \
      OWNER_EMAIL=you@example.com LOCAL_ADMIN=yes npm start

Sign-in codes are printed instead of emailed; photos go in `./media-files`.

Tests: `npm test` (uses the database in `DATABASE_URL`, default
`postgres://postgres@127.0.0.1:55432/social_test`, and wipes it).

## AWS

`infra/` is the AWS setup (CDK), sharing ticket-hub's network, load balancer
(rules 7–8) and database server. Merging to `main` deploys it (GitHub
Actions → Deploy, as the `social-github-deploy` role).
