-- Nearby is for real photos taken around here.

alter table posts
  -- A photo says it was made by AI (content credentials or IPTC metadata
  -- written by the AI tool), or the owner decided so from a report.
  add column ai_made boolean not null default false,
  add column ai_reason text,
  -- Every photo was taken recently, close to where it was posted (from the
  -- camera's own time and place, which are compared and then thrown away).
  add column taken_here boolean not null default false;

-- "Fake or AI-made photo" as a report reason.
alter table reports drop constraint reports_reason_check;
alter table reports add constraint reports_reason_check
  check (reason in ('nudity', 'minor', 'harassment', 'hate', 'violence', 'self_harm', 'spam', 'impersonation', 'fake_ai', 'other'));

insert into settings (key, value) values
  ('nearby_ai_filter', 'true'),
  ('taken_here_badge', 'true'),
  -- How recent, and how close, a photo must be for the badge.
  ('taken_here_hours', '24'),
  ('taken_here_miles', '5')
on conflict (key) do nothing;
