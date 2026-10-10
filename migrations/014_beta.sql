-- Beta polish: feedback, email nudges and the numbers on Admin → Beta.

-- "Send feedback" from the app.
create table feedback (
  id bigserial primary key,
  user_id bigint references users (id) on delete set null,
  kind text not null check (kind in ('idea', 'problem', 'other')),
  body text not null,
  -- The page they were on when they tapped "Send feedback".
  page text not null default '',
  device text not null default '',
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index feedback_open on feedback (created_at desc) where done_at is null;

-- Email nudges: gentle emails about unread messages and what's new nearby.
-- Each person can turn them off (Settings, or the link in every email).
alter table users
  add column email_nudges boolean not null default true,
  add column messages_nudged_at timestamptz,
  add column digest_sent_at timestamptz;

-- Which days each person used the site (for Admin → Beta). One row per person per day.
create table active_days (
  user_id bigint not null references users (id) on delete cascade,
  day date not null,
  primary key (day, user_id)
);

-- Counts of things that don't stay in the database (disappearing messages).
create table daily_counts (
  day date not null,
  kind text not null,
  n integer not null default 0,
  primary key (day, kind)
);

insert into settings (key, value) values ('email_nudges_enabled', 'true') on conflict (key) do nothing;
