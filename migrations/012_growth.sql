-- Growth: members' own invite cards, and the daily recap.
alter table invites add column created_by bigint references users (id) on delete cascade;
create unique index invites_one_per_member on invites (created_by) where created_by is not null and revoked_at is null;

insert into settings (key, value) values
  -- How many people each member's invite card can bring in (0 = members can't invite).
  ('invites_per_member', '5'),
  ('today_recap_enabled', 'true')
on conflict (key) do nothing;
