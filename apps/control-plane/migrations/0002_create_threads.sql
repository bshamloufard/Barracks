-- Thread records: what the control plane needs to run each thread. Like the
-- event log's tables, this one lives in the `barrack` schema with row level
-- security on and no policies, so Supabase's Data API could never serve it
-- (see 0001_create_thread_event_log.sql for why).
--
-- `thread_events` has no foreign key to this table: history recorded before
-- threads had records (Milestone 1's hand-started threads) stays readable.
create table threads (
  -- The protocol's `threadIdSchema` (packages/protocol/src/identifier.ts).
  thread_id text primary key check (thread_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  created_at timestamptz not null,
  -- Which provider was asked for the sandbox; `sandbox_id` means nothing to
  -- any other provider.
  sandbox_provider text not null check (sandbox_provider <> ''),
  -- SHA-256 of the supervisor's token. The token itself is never stored, so
  -- reading this table does not let anyone connect as a thread's supervisor.
  supervisor_token_digest bytea not null check (octet_length(supervisor_token_digest) = 32),
  sandbox_state text not null check (sandbox_state in ('creating', 'ready', 'failed')),
  sandbox_id text check (sandbox_id <> ''),
  sandbox_failure_reason text check (sandbox_failure_reason <> ''),
  -- A ready sandbox always has an identifier and only a failed one a reason.
  check ((sandbox_state = 'ready') = (sandbox_id is not null)),
  check ((sandbox_state = 'failed') = (sandbox_failure_reason is not null))
);

-- The thread list reads the newest threads first.
create index threads_newest_first on threads (created_at desc, thread_id desc);

alter table threads enable row level security;
