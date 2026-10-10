-- Ripples (posts reach further as people engage), "all caught up", and
-- room for the notifications the next features add.

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in ('like', 'comment', 'follow', 'mention', 'ripple', 'moment', 'answer', 'thanks', 'flare', 'badge'));
-- Extra detail for some kinds (e.g. how far a post rippled).
alter table notifications add column detail text;

-- When each person last looked at Nearby (for "new since you last looked").
alter table users add column nearby_seen_at timestamptz;

insert into settings (key, value) values
  ('ripples_enabled', 'true'),
  -- A new post reaches this far; with enough likes + comments, further.
  ('ripple_start_miles', '10'),
  ('ripple_2_at', '3'),
  ('ripple_2_miles', '25'),
  ('ripple_3_at', '10'),
  ('ripple_3_miles', '50'),
  -- Nearby shows posts from the last this-many days.
  ('nearby_days', '14')
on conflict (key) do nothing;
