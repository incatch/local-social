-- Pull Up (show up to a post or plan) and Squads with IRL streaks.

-- "On my way" and "pulled up 👋" (with an optional selfie) on a post or a plan.
create table pull_ups (
  id bigserial primary key,
  user_id bigint not null references users (id) on delete cascade,
  post_id bigint references posts (id) on delete cascade,
  signal_id bigint references signals (id) on delete cascade,
  status text not null check (status in ('coming', 'here')),
  photo_key text,
  created_at timestamptz not null default now(),
  arrived_at timestamptz,
  check ((post_id is null) <> (signal_id is null))
);
create unique index pull_ups_post on pull_ups (post_id, user_id) where post_id is not null;
create unique index pull_ups_signal on pull_ups (signal_id, user_id) where signal_id is not null;
create index pull_ups_user on pull_ups (user_id, arrived_at);

-- Squads: up to 8 friends who follow each other.
create table squads (
  id bigserial primary key,
  name text not null,
  emoji text not null default '🫂',
  created_by bigint references users (id) on delete set null,
  -- The week we last reminded them their streak is about to end.
  reminded_week date,
  created_at timestamptz not null default now()
);
create table squad_members (
  squad_id bigint not null references squads (id) on delete cascade,
  user_id bigint not null references users (id) on delete cascade,
  status text not null check (status in ('invited', 'member')),
  invited_by bigint references users (id) on delete set null,
  created_at timestamptz not null default now(),
  joined_at timestamptz,
  primary key (squad_id, user_id)
);
create index squad_members_user on squad_members (user_id);

-- The squad chat (kept for 7 days).
create table squad_messages (
  id bigserial primary key,
  squad_id bigint not null references squads (id) on delete cascade,
  user_id bigint not null references users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
create index squad_messages_by_squad on squad_messages (squad_id, id);

-- Weeks (starting Monday, site time) when the squad did something real together.
create table squad_weeks (
  squad_id bigint not null references squads (id) on delete cascade,
  week date not null,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (squad_id, week)
);

alter table notifications add column squad_id bigint references squads (id) on delete cascade;
alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in ('like', 'comment', 'follow', 'mention', 'ripple', 'moment', 'answer', 'thanks', 'flare', 'badge',
                  'coming', 'pulled_up', 'squad_invite', 'squad_join', 'squad_streak', 'squad_reminder'));
