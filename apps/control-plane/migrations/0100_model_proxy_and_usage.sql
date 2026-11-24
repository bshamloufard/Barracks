-- Keys kept out of sandboxes, and usage counted and capped. Like every table
-- here, these live in the `barrack` schema with row level security on and
-- no policies (see 0001_create_thread_event_log.sql). Every change only adds
-- tables and a nullable column, so a control plane of the previous release,
-- still serving during a redeploy, is unaffected.

-- The tokens a thread's agent presents to the control plane's model proxy
-- in place of its owner's key, one minted for each supervisor connection
-- and provider. Only their SHA-256 digests are stored, so reading this
-- table lets nobody use the proxy. A thread's are removed when its sandbox
-- begins stopping or the thread is deleted; the proxy also accepts one only
-- while the thread's sandbox is recorded running.
create table model_proxy_tokens (
  thread_id text not null references threads (thread_id) on delete cascade,
  provider_id text not null check (provider_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  token_digest bytea not null check (octet_length(token_digest) = 32),
  minted_at timestamptz not null,
  primary key (thread_id, provider_id, token_digest)
);

alter table model_proxy_tokens enable row level security;

-- Tokens used, added up per user, thread, model, source and hour: one row for
-- each hour a thread used a model, however many answers. `source` says how
-- the numbers were counted: `measured` from the provider's own answer at
-- the proxy, `estimated` at the proxy for an answer that ended before the
-- provider said, `reported` by the sandbox (untrusted). The four token
-- columns never overlap: input tokens exclude those read from or written to
-- the provider's prompt cache. A thread's rows outlive the thread, since
-- its usage still counts towards its owner's totals and cap.
create table model_usage (
  user_id text not null references users (user_id) on delete cascade,
  thread_id text not null check (thread_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  provider_id text not null check (provider_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  model_id text not null check (model_id <> '' and char_length(model_id) <= 256),
  source text not null check (source in ('measured', 'estimated', 'reported')),
  hour timestamptz not null check (hour = date_trunc('hour', hour)),
  input_tokens bigint not null check (input_tokens >= 0),
  output_tokens bigint not null check (output_tokens >= 0),
  cache_read_tokens bigint not null check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null check (cache_write_tokens >= 0),
  answer_count bigint not null check (answer_count >= 0),
  primary key (user_id, thread_id, provider_id, model_id, source, hour)
);

-- The cap and the settings page add up one user's recent hours.
create index model_usage_by_user_and_hour on model_usage (user_id, hour);

alter table model_usage enable row level security;

-- A cap a user set on themselves, below the installation's if it has one.
create table model_usage_caps (
  user_id text primary key references users (user_id) on delete cascade,
  cap_tokens bigint not null check (cap_tokens > 0)
);

alter table model_usage_caps enable row level security;

-- SHA-256 of the email address the sign-in service last confirmed the user
-- owns, so the model proxy can tell, without a request from the user, that
-- an installation admitting listed addresses no longer admits them. Null
-- until the user next signs in with a confirmed address.
alter table users add column confirmed_email_digest bytea
  check (octet_length(confirmed_email_digest) = 32);
