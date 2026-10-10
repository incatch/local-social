-- Moments: when several people post from the same spot around the same
-- time (a game, a festival, a parade), their posts become one shared album.

create table moments (
  id bigserial primary key,
  -- Where (rounded, like everything else) and the town's name.
  lat double precision not null,
  lon double precision not null,
  area_name text,
  title text not null,
  started_at timestamptz not null default now(),
  last_post_at timestamptz not null default now()
);
create index moments_recent on moments (last_post_at desc);

create table moment_posts (
  moment_id bigint not null references moments (id) on delete cascade,
  post_id bigint not null references posts (id) on delete cascade,
  primary key (moment_id, post_id)
);
create unique index moment_posts_once on moment_posts (post_id);

insert into settings (key, value) values
  ('moments_enabled', 'true'),
  -- A Moment starts when this many different people post within this many
  -- miles of each other, within this many hours.
  ('moment_people', '3'),
  ('moment_miles', '1'),
  ('moment_hours', '3')
on conflict (key) do nothing;
