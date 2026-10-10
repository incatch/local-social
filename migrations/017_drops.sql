-- Drops (photos and notes left at public places) and Where It's At.

-- Public places near a spot (from OpenStreetMap), kept for 30 days.
create table places_cache (
  cell text primary key,
  places jsonb not null,
  fetched_at timestamptz not null default now()
);

create table drops (
  id bigserial primary key,
  user_id bigint not null references users (id) on delete cascade,
  -- The public place it's left at (its own map position, never where the person was).
  place_name text not null,
  place_kind text not null default '',
  lat double precision not null,
  lon double precision not null,
  note text not null default '',
  photo_key text,
  status text not null default 'visible' check (status in ('visible', 'removed')),
  expires_at timestamptz not null default now() + interval '30 days',
  created_at timestamptz not null default now()
);
create index drops_live on drops (lat, lon) where status = 'visible';
create index drops_by_user on drops (user_id);

-- Who found which Drop. Only the finder sees this; the person who left it
-- only ever sees how many found it.
create table drop_finds (
  drop_id bigint not null references drops (id) on delete cascade,
  user_id bigint not null references users (id) on delete cascade,
  found_at timestamptz not null default now(),
  primary key (drop_id, user_id)
);
create index drop_finds_user on drop_finds (user_id);

alter table notifications add column drop_id bigint references drops (id) on delete cascade;
alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in ('like', 'comment', 'follow', 'mention', 'ripple', 'moment', 'answer', 'thanks', 'flare', 'badge',
                  'coming', 'pulled_up', 'squad_invite', 'squad_join', 'squad_streak', 'squad_reminder', 'drop_found'));

-- Where It's At: how many different people make a spot glow.
insert into settings (key, value) values ('heat_min_people', '3') on conflict (key) do nothing;
