-- Signals: quick text posts sent to the people around you. Questions, plans
-- ("who's in?"), lost & found, and polls. They expire on their own.

create table signals (
  id bigserial primary key,
  user_id bigint not null references users (id) on delete cascade,
  kind text not null check (kind in ('ask', 'plan', 'lost', 'poll')),
  body text not null,
  -- A plan's time; a poll's options (2-4 strings).
  plan_at timestamptz,
  options jsonb,
  -- Where it was sent from (rounded, like everything else).
  lat double precision not null,
  lon double precision not null,
  area_name text,
  status text not null default 'visible' check (status in ('visible', 'removed')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index signals_live on signals (expires_at) where status = 'visible';
create index signals_place on signals (lat, lon) where status = 'visible';

create table signal_replies (
  id bigserial primary key,
  signal_id bigint not null references signals (id) on delete cascade,
  user_id bigint not null references users (id) on delete cascade,
  body text not null,
  thanked boolean not null default false,
  created_at timestamptz not null default now()
);
create index signal_replies_by_signal on signal_replies (signal_id, created_at);

-- "I'm in" on plans, and poll votes.
create table signal_joins (
  signal_id bigint not null references signals (id) on delete cascade,
  user_id bigint not null references users (id) on delete cascade,
  primary key (signal_id, user_id)
);
create table signal_votes (
  signal_id bigint not null references signals (id) on delete cascade,
  user_id bigint not null references users (id) on delete cascade,
  choice integer not null,
  primary key (signal_id, user_id)
);

-- Signals can be reported, and notified about.
alter table reports add column signal_id bigint references signals (id) on delete set null;
alter table reports drop constraint reports_target_type_check;
alter table reports add constraint reports_target_type_check check (target_type in ('post', 'comment', 'user', 'message', 'signal'));
alter table notifications add column signal_id bigint references signals (id) on delete cascade;

insert into settings (key, value) values ('signals_enabled', 'true') on conflict (key) do nothing;
drop index reports_once;
create unique index reports_once on reports (reporter_id, target_type, coalesce(post_id, 0), coalesce(comment_id, 0), coalesce(message_id, 0), coalesce(signal_id, 0), user_id) where status = 'open';
alter table moderated_items drop constraint moderated_items_source_check;
alter table moderated_items add constraint moderated_items_source_check check (source in ('post', 'comment', 'message', 'snap', 'avatar', 'upload', 'signal'));
