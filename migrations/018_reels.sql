-- Video clips in posts, and Moment Reels.

-- A clip's video (MP4, silent). The photo and thumbnail keys hold its
-- first frame, so everything that shows photos keeps working.
alter table post_photos add column video_key text;

-- Each Moment Reel made, for one set of posts (people only see a reel made
-- from posts they're allowed to see, so there can be more than one).
create table reels (
  id bigserial primary key,
  moment_id bigint not null references moments (id) on delete cascade,
  posts_hash text not null,
  status text not null check (status in ('rendering', 'ready', 'failed')),
  video_key text,
  poster_key text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (moment_id, posts_hash)
);

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in ('like', 'comment', 'follow', 'mention', 'ripple', 'moment', 'answer', 'thanks', 'flare', 'badge',
                  'coming', 'pulled_up', 'squad_invite', 'squad_join', 'squad_streak', 'squad_reminder', 'drop_found', 'reel'));
