-- Part 2: posts, likes, comments, follows and the feeds.

-- Where to show "Nearby" from: the viewer's latest location (rounded to
-- ~1 mile, like everything else) and how far they want to see.
alter table users
  add column feed_lat double precision,
  add column feed_lon double precision,
  add column feed_radius_miles integer not null default 10 check (feed_radius_miles in (5, 10, 25, 50));

create table posts (
  id bigserial primary key,
  user_id bigint not null references users (id) on delete cascade,
  caption text not null default '',
  -- Where it was posted from: rounded to ~1 mile, and the town's name.
  -- Posts without a location only show on profiles and the Following feed.
  lat double precision,
  lon double precision,
  area_name text,
  -- 'visible', or 'removed' by moderation (part 4).
  status text not null default 'visible' check (status in ('visible', 'removed')),
  like_count integer not null default 0,
  comment_count integer not null default 0,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index posts_by_user on posts (user_id, created_at desc);
create index posts_recent on posts (created_at desc) where status = 'visible';
create index posts_place on posts (lat, lon) where status = 'visible' and lat is not null;

create table post_photos (
  post_id bigint not null references posts (id) on delete cascade,
  position integer not null,
  -- Full size (up to 1600px) and a square thumbnail for profile grids.
  photo_key text not null,
  thumb_key text not null,
  width integer not null,
  height integer not null,
  primary key (post_id, position)
);

create table likes (
  post_id bigint not null references posts (id) on delete cascade,
  user_id bigint not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index likes_by_user on likes (user_id);

create table comments (
  id bigserial primary key,
  post_id bigint not null references posts (id) on delete cascade,
  user_id bigint not null references users (id) on delete cascade,
  body text not null,
  status text not null default 'visible' check (status in ('visible', 'removed')),
  created_at timestamptz not null default now()
);
create index comments_by_post on comments (post_id, created_at);

create table follows (
  follower_id bigint not null references users (id) on delete cascade,
  followee_id bigint not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index follows_followee on follows (followee_id);

-- Who was @mentioned where (notifications come with messages, in part 3).
create table mentions (
  id bigserial primary key,
  user_id bigint not null references users (id) on delete cascade,
  by_user_id bigint not null references users (id) on delete cascade,
  post_id bigint references posts (id) on delete cascade,
  comment_id bigint references comments (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index mentions_by_user on mentions (user_id, created_at desc);
