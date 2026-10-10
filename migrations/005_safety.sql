-- Part 4: blocking, reports, photo screening and moderation.

create table blocks (
  blocker_id bigint not null references users (id) on delete cascade,
  blocked_id bigint not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index blocks_blocked on blocks (blocked_id);

-- Posts and comments can now be 'held' (waiting for the owner's review:
-- flagged by photo screening, or reported by several people).
alter table posts drop constraint posts_status_check;
alter table posts add constraint posts_status_check check (status in ('visible', 'held', 'removed'));
alter table comments drop constraint comments_status_check;
alter table comments add constraint comments_status_check check (status in ('visible', 'held', 'removed'));
-- What photo screening saw (Amazon Rekognition labels), if anything.
alter table posts add column screen_labels jsonb;

-- After a snap is opened its photo is kept for a short while so the person
-- who saw it can report it, then deleted.
alter table messages add column report_key text, add column report_until timestamptz;

-- Reports from people using the site.
create table reports (
  id bigserial primary key,
  reporter_id bigint references users (id) on delete set null,
  target_type text not null check (target_type in ('post', 'comment', 'user', 'message')),
  -- Who the report is about, and what (whichever applies).
  user_id bigint references users (id) on delete cascade,
  post_id bigint references posts (id) on delete set null,
  comment_id bigint references comments (id) on delete set null,
  -- Messages disappear, so what was reported is copied here.
  message_id bigint,
  snapshot_text text,
  snapshot_key text,
  reason text not null check (reason in ('nudity', 'minor', 'harassment', 'hate', 'violence', 'self_harm', 'spam', 'impersonation', 'other')),
  details text not null default '',
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index reports_open on reports (created_at) where status = 'open';
create unique index reports_once on reports (reporter_id, target_type, coalesce(post_id, 0), coalesce(comment_id, 0), coalesce(message_id, 0), user_id) where status = 'open';

-- The moderated-out store: everything taken down or refused, with why, for
-- the owner's records and (except legal holds) for training a moderation
-- model later. Kept even if the person deletes their account.
create table moderated_items (
  id bigserial primary key,
  source text not null check (source in ('post', 'comment', 'message', 'snap', 'avatar', 'upload')),
  user_id bigint references users (id) on delete set null,
  username text,
  body text not null default '',
  -- Copies of the photos, under moderated/ (separate from live photos).
  media_keys text[] not null default '{}',
  -- Photo screening labels, and the reasons people gave when reporting.
  labels jsonb,
  report_reasons text[] not null default '{}',
  -- 'removed' by the owner, 'refused' by screening at upload, or
  -- 'legal_hold' (possible child sexual abuse material: never used for
  -- training, never shown, kept only as the law requires).
  decision text not null check (decision in ('removed', 'refused', 'legal_hold')),
  training_ok boolean not null default true,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index moderated_recent on moderated_items (created_at desc);
