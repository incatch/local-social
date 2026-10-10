-- Part 1: accounts, profiles and invites.

create table settings (
  key text primary key,
  value text not null
);
insert into settings (key, value) values
  ('site_name', 'Local Social'),
  -- During the beta, new accounts need an invite code (Admin → Invites).
  ('invite_only', 'true');

create table invites (
  id bigserial primary key,
  code text not null unique,
  -- Who it's for, so the owner remembers (e.g. "Sam from work").
  note text not null default '',
  max_uses integer not null default 1 check (max_uses > 0),
  uses integer not null default 0,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table users (
  id bigserial primary key,
  email text not null unique check (email = lower(email)),
  -- Set when sign-up is finished (until then the account can't do anything).
  username text unique check (username ~ '^[a-z0-9_.]{3,30}$'),
  display_name text,
  bio text not null default '',
  -- The nearest town to where they set their area ("Springfield, MO"), and
  -- that place rounded to ~1 mile. Never an exact location.
  area_name text,
  area_lat double precision,
  area_lon double precision,
  photo_key text,
  -- They confirmed their date of birth makes them 18+ (the date itself isn't kept).
  adult_confirmed_at timestamptz,
  terms_accepted_at timestamptz,
  invite_id bigint references invites (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'banned')),
  banned_reason text,
  -- Bumping this signs the person out on every device.
  session_version integer not null default 1,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table signin_codes (
  id bigserial primary key,
  email text not null,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index signin_codes_email on signin_codes (email, created_at desc);
