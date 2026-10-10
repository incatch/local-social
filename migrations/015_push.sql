-- Phone notifications (web push), the first look, and Admin → New features.

-- Each phone or computer that turned on notifications.
create table push_subscriptions (
  id bigserial primary key,
  user_id bigint not null references users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device text not null default '',
  created_at timestamptz not null default now(),
  last_sent_at timestamptz
);
create index push_subscriptions_user on push_subscriptions (user_id);

-- When each notification / message was sent to phones (so it's sent once,
-- even with several containers running).
alter table notifications add column pushed_at timestamptz;
alter table messages add column pushed_at timestamptz;
update notifications set pushed_at = created_at;
update messages set pushed_at = created_at;
create index notifications_to_push on notifications (id) where pushed_at is null;
create index messages_to_push on messages (id) where pushed_at is null;

-- New features, each Off, 18+ only ("adults") or Everyone (Admin → New features).
insert into settings (key, value) values
  ('feature_pullup', 'adults'),
  ('feature_squads', 'adults'),
  ('feature_drops', 'adults'),
  ('feature_heatmap', 'adults'),
  ('feature_reels', 'adults')
on conflict (key) do nothing;
