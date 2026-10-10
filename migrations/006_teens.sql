-- Teen mode: 13–17-year-olds in a world of their own. Off until the owner
-- turns it on in Admin → Teen mode; every rule below is a setting there.

-- For people under 18: the day they turn 18 (and become an adult account
-- automatically). Nothing else about their birthday is kept. Null = adult.
alter table users
  add column teen_until date,
  -- Parental consent (when Admin requires it for younger teens).
  add column needs_parent_consent boolean not null default false,
  add column parent_email text,
  add column parent_consent_token text,
  add column parent_consent_at timestamptz;

insert into settings (key, value) values
  ('teens_enabled', 'false'),
  ('teen_min_age', '13'),
  -- US states where teens may join, e.g. 'MO,KS' ('' = anywhere).
  ('teen_states', ''),
  -- Who teens can message: 'mutual' (people they follow who follow them
  -- back), 'followers' (people who follow them), or 'requests' (any teen,
  -- with message requests like adults).
  ('teen_messages', 'mutual'),
  -- View-once photos for teens: 'off', 'mutual' (only with mutual follows) or 'on'.
  ('teen_photos', 'mutual'),
  -- Hold teen photos showing swimwear or partial nudity for review.
  ('teen_strict_screening', 'true'),
  -- Show distances ("3 mi") to teens on Nearby (the town is always shown).
  ('teen_show_distance', 'false'),
  -- The smallest Nearby distance teens can pick.
  ('teen_min_radius', '10'),
  -- Teens under this age need a parent's OK by email ('0' = never).
  ('parental_consent_under', '0')
on conflict (key) do nothing;

-- One place decides who can see and reach whom: nobody across a block, and
-- adults and teens never at all.
create function is_teen(uid bigint) returns boolean language sql stable as $$
  select coalesce((select teen_until > current_date from users where id = uid), false)
$$;
create function can_interact(a bigint, b bigint) returns boolean language sql stable as $$
  select not exists (select 1 from blocks where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a))
     and is_teen(a) = is_teen(b)
$$;
