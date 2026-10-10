-- Local badges, earned by being real and out in town (never by follower counts).
create table user_badges (
  user_id bigint not null references users (id) on delete cascade,
  badge text not null,
  earned_at timestamptz not null default now(),
  primary key (user_id, badge)
);
insert into settings (key, value) values ('badges_enabled', 'true') on conflict (key) do nothing;
