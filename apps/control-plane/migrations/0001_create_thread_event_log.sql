-- The thread event log: every thread's ordered history. The migration runner
-- sets the search path to the control plane's own schema (`barrack`), so the
-- tables below are created there rather than in `public`.
--
-- Why a schema of our own, and row level security with no policies:
-- Supabase serves the `public` schema through its generated Data API to anyone
-- holding the project's publishable key, and existing projects grant new
-- tables there to the `anon` and `authenticated` roles automatically. A schema
-- is only served once it is added to the API's exposed schemas and those
-- roles are granted access to it. Row level security with no policies is the
-- second fence: were this schema ever exposed and granted, those roles would
-- still read and write no rows. The control plane connects as the role that
-- owns these tables, and row level security does not apply to a table's owner.
--   https://supabase.com/docs/guides/api/using-custom-schemas
--   https://supabase.com/docs/guides/api/securing-your-api
--   https://www.postgresql.org/docs/current/ddl-rowsecurity.html

-- One row per thread, holding the sequence of its newest event. Appending an
-- event updates this row and inserts the event in one statement, so the row
-- lock serialises appends to one thread, even from two control plane
-- instances: sequences are handed out with no gaps and commit in order.
-- Appends to different threads lock different rows and never wait for each
-- other.
create table thread_sequence_counters (
  -- The protocol's `threadIdSchema` (packages/protocol/src/identifier.ts).
  thread_id text primary key check (thread_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  last_sequence bigint not null check (last_sequence > 0)
);

alter table thread_sequence_counters enable row level security;

-- `event` is `json`, which keeps the exact text it was given, rather than
-- `jsonb`, which cannot hold the character U+0000 or an unpaired UTF-16
-- surrogate and rejects any event containing one. Tool output from a sandbox
-- can contain U+0000 (a binary file printed to the terminal, say), and a
-- rejected append would disconnect the thread's supervisor. History is only
-- ever read back whole, in sequence order, so nothing needs `jsonb`'s
-- indexing or operators.
--   https://www.postgresql.org/docs/current/datatype-json.html
create table thread_events (
  thread_id text not null check (thread_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  sequence bigint not null check (sequence > 0),
  recorded_at timestamptz not null,
  event json not null,
  primary key (thread_id, sequence)
);

alter table thread_events enable row level security;
