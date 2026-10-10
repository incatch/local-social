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
unban, invites (with join links), and opening sign-ups to everyone.

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
