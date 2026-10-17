-- Founding members: open sign-ups (no invite needed) until the first 500
-- have joined, a waitlist after that, and which ad or link brought each person.

insert into settings (key, value) values
  ('founding_limit', '500'),
  ('founding_open', 'false'),
  ('founding_area', 'Springfield')
on conflict (key) do nothing;

-- Where someone came from (an ad's ?utm_source=…&utm_campaign=…, or ?ref=…).
alter table users add column signup_source text;

create table waitlist (
  id bigserial primary key,
  email text not null unique check (email = lower(email)),
  source text,
  invite_id bigint references invites (id) on delete set null,
  created_at timestamptz not null default now(),
  invited_at timestamptz
);
