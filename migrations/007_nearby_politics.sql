-- Political posts stay off the Nearby feed (followers still see them).

alter table posts
  -- What was found in the photos: their text (read by Rekognition) and
  -- any well-known people recognised in them.
  add column image_text text not null default '',
  add column image_people jsonb not null default '[]',
  -- false = kept off Nearby, and why. The owner can show it anyway.
  add column nearby_ok boolean not null default true,
  add column nearby_reason text,
  add column nearby_override boolean not null default false;

-- Whether a recognised person (by Wikidata id) is a political figure, so
-- each is only looked up once.
create table political_people (
  wikidata_id text primary key,
  name text not null,
  political boolean not null,
  checked_at timestamptz not null default now()
);

insert into settings (key, value) values
  ('nearby_politics_filter', 'true'),
  -- Words and phrases that make a post political (one per line), and extra
  -- names of political figures; both editable in Admin → Nearby rules.
  ('political_words', ''),
  ('political_names', '')
on conflict (key) do nothing;
