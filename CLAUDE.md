# Notes for Claude

- This is Radius (repo local-social, https://social.plopza.com), tagline
  "Your world. Happening now.": photo posts,
  a feed of what's near you, disappearing messages with view-once photos. Built in four parts
  (see README.md); later it moves into ticket-hub for enhancements.
- The owner is a smart non-engineer. Explain in plain English.
- Privacy rules that must not regress (each has tests):
  - Never store or show an exact location. Round with `roundLocation`
    (~1 mile) before using or saving; show only the nearest town's name.
  - Every uploaded image goes through `processImage` (strips EXIF/GPS).
  - 18+ only; the date of birth isn't stored.
  - Profiles and posts are public to signed-in members; photos are served
    by the site (never public bucket URLs) so access can be checked.
- Moderation (part 4): content removed for breaking the rules is kept,
  labelled, for training a moderation model later. Anything that may involve
  a minor must never go into that training store: legal hold and NCMEC
  reporting only.
- Never put secrets in the code; they live in AWS Secrets Manager.
- Run `npm test` (needs PostgreSQL; see README.md) before finishing.
- Wording: on screen, a photo sent in a message is a "photo" (it "opens
  once"); never call it a "snap". The code calls it a snap internally
  (kind 'snap'), which nobody sees. Don't compare Radius to Instagram or
  Snapchat anywhere people can see.
