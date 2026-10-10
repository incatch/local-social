# Radius

*Your world. Happening now.*

Instagram shows you people you know. Radius introduces you to the people
around you: Instagram-style posts and a feed of what's happening near you,
with Snapchat-style messages. Every profile is public; nobody's exact location
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
3. **Messages and snaps**: message requests, view-once snaps, chat that
   disappears 24 hours after it's read (unless both save it), notifications.
4. **Safety**: report and block, automatic photo screening, the admin
   moderation queue, and the moderated-out store (labelled, for training a
   moderation model later; anything involving minors goes to legal hold, never
   training).

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
