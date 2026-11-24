-- Users, and which user each thread belongs to. Like every table here, they
-- live in the `barrack` schema with row level security on and no policies,
-- so Supabase's Data API could never serve them (see
-- 0001_create_thread_event_log.sql for why).
--
-- One row per user of the sign-in service, keyed by its stable identifier
-- for them (Supabase's `sub`, a UUID; text, so that another issuer's
-- identifiers fit too). A row is added on the user's first authenticated
-- request.
--
-- There is deliberately no foreign key to Supabase's `auth.users`: the
-- control plane must also run on plain Postgres with another sign-in
-- service, its tests run on a Postgres without an `auth` schema, and its
-- database role need not be allowed to reference Supabase's tables. Deleting
-- a user in Supabase therefore leaves their rows here, and their sandboxes
-- running; deleting an account has to stop those itself (see the decision
-- log).
create table users (
  user_id text primary key check (user_id <> '' and length(user_id) <= 255),
  created_at timestamptz not null
);

alter table users enable row level security;

-- Every thread created from now on records its owner, and is only ever shown
-- to and controlled by that user. Threads created before sign-in existed
-- have no owner, and so are shown to nobody; an operator who wants one back
-- can give it an owner by hand once that user has signed in:
--   update barrack.threads set owner_user_id = '<user id>' where thread_id = '<thread id>';
-- Nothing was ever deployed before sign-in, so only development databases
-- hold such threads.
alter table threads add column owner_user_id text references users (user_id);

-- The thread list reads one user's newest threads first. It replaces the
-- index for every thread's newest first, which nothing reads any more.
create index threads_newest_first_by_owner on threads (owner_user_id, created_at desc, thread_id desc);

drop index threads_newest_first;
