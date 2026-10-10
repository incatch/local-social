-- Part 3: messages, snaps and notifications.

-- A chat between two people. user_a is always the lower id, so each pair
-- has one conversation.
create table conversations (
  id bigserial primary key,
  user_a bigint not null references users (id) on delete cascade,
  user_b bigint not null references users (id) on delete cascade,
  -- Who sent the first message. Until the other person accepts (or replies),
  -- it's a message request: it waits in their Requests, and only a few text
  -- messages can be sent (no snaps).
  started_by bigint not null references users (id) on delete cascade,
  accepted_at timestamptz,
  -- Each person can choose to keep the chat. Only when both have, read
  -- messages stop disappearing.
  a_keeps boolean not null default false,
  b_keeps boolean not null default false,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (user_a, user_b),
  check (user_a < user_b)
);
create index conversations_b on conversations (user_b, last_message_at desc);
create index conversations_a on conversations (user_a, last_message_at desc);

create table messages (
  id bigserial primary key,
  conversation_id bigint not null references conversations (id) on delete cascade,
  sender_id bigint not null references users (id) on delete cascade,
  -- 'text', or a 'snap': a photo the other person can open once.
  kind text not null check (kind in ('text', 'snap')),
  body text not null default '',
  -- A snap's photo, until it's opened (then it's deleted).
  photo_key text,
  -- When the other person first saw it (for a snap: opened it). Read
  -- messages are deleted 24 hours later unless both people keep the chat.
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index messages_by_conversation on messages (conversation_id, id);
create index messages_unread on messages (conversation_id) where read_at is null;
create index messages_to_purge on messages (read_at) where read_at is not null;

-- Likes, comments, follows and @mentions, for the Activity page.
create table notifications (
  id bigserial primary key,
  user_id bigint not null references users (id) on delete cascade,
  actor_id bigint not null references users (id) on delete cascade,
  kind text not null check (kind in ('like', 'comment', 'follow', 'mention')),
  post_id bigint references posts (id) on delete cascade,
  comment_id bigint references comments (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index notifications_by_user on notifications (user_id, created_at desc);

-- When each person last looked at their Activity (for the badge).
alter table users add column activity_seen_at timestamptz not null default now();
