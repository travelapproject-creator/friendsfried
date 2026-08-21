-- Friends Fried — Postgres schema
-- Matches the prototype: tables seat 5, seat lock-in, daily posts, escalating praise/fry, comments, history.
-- Scoring (computed at read time, see GET /tables/:code/scores): each post's score starts at the AI's
-- 0-10 health read; each praise vote is +1, each fry vote is -1, clamped 0-10.
-- Leaderboard score = average of a seat's post scores for the week; lowest average is Fry of the Week.

create extension if not exists "pgcrypto";

create table tables (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,          -- 4-letter join code
  group_name    text not null,
  created_at    timestamptz not null default now()
);

create table seats (
  id            uuid primary key default gen_random_uuid(),
  table_id      uuid not null references tables(id) on delete cascade,
  seat_index    int not null check (seat_index between 0 and 4),
  name          text not null,
  emoji         text,
  is_host       boolean not null default false,  -- seat 0 = creator/admin
  claimed_at    timestamptz not null default now(),
  unique (table_id, seat_index)
);

create table posts (
  id            uuid primary key default gen_random_uuid(),
  table_id      uuid not null references tables(id) on delete cascade,
  seat_id       uuid not null references seats(id) on delete cascade,
  post_date     date not null default current_date,  -- one post per seat per day
  image_url     text not null,
  caption       text,
  ai_score      int check (ai_score between 1 and 100),  -- Claude's 1-100 health-score rating of the plate
  ai_verdict    text,                                    -- Claude's one-line verdict
  poster_note   text,                                    -- poster's correction if the AI misread the plate; re-rates using this context
  ai_health     int check (ai_health between 0 and 10),   -- Claude's healthiness read, 0-10 (informational only, doesn't affect the leaderboard)
  created_at    timestamptz not null default now(),
  unique (seat_id, post_date)
);

-- Migration: run if the posts table already exists without these columns
-- alter table posts add column if not exists ai_score int check (ai_score between 1 and 100);
-- alter table posts add column if not exists ai_verdict text;
-- alter table posts add column if not exists poster_note text;
-- alter table posts add column if not exists ai_health int check (ai_health between 0 and 10);

create table votes (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references posts(id) on delete cascade,
  voter_seat_id uuid not null references seats(id) on delete cascade,
  vote_type     text not null check (vote_type in ('praise', 'fry')),
  created_at    timestamptz not null default now(),
  unique (post_id, voter_seat_id)  -- one active vote per person per post; app computes escalating points from vote order/count
);

create table comments (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references posts(id) on delete cascade,
  seat_id       uuid not null references seats(id) on delete cascade,
  text          text not null,
  created_at    timestamptz not null default now(),
  edited_at     timestamptz
);

create index on posts (table_id, post_date);
create index on votes (post_id);
create index on comments (post_id);
