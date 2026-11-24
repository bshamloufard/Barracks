-- Each user's own model access: the API keys they add, one per model
-- provider, and the model each thread runs on. Like every table here, it
-- lives in the `barrack` schema with row level security on and no policies
-- (see 0001_create_thread_event_log.sql).
--
-- A key is never stored readable. The control plane seals each with
-- AES-256-GCM under a key from its own configuration, which the database
-- never holds, bound to the row's user and provider (as the cipher's
-- associated data), so a sealed key copied to another row does not open.
-- `key_fingerprint` names which configured key sealed it, never the key.
-- `secret_ending`, the key's last four characters, is kept readable so a
-- user can tell two keys apart without any key being opened.
create table model_credentials (
  user_id text not null references users (user_id) on delete cascade,
  provider_id text not null check (provider_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  key_fingerprint text not null check (key_fingerprint ~ '^[0-9a-f]{16}$'),
  nonce bytea not null check (octet_length(nonce) = 12),
  -- The sealed key and settings, then GCM's 16-byte authentication tag.
  ciphertext bytea not null check (octet_length(ciphertext) > 16),
  secret_ending text not null check (char_length(secret_ending) <= 4),
  added_at timestamptz not null,
  primary key (user_id, provider_id)
);

-- Counting credentials by key, at every startup, to find any sealed under
-- a key the control plane was not given.
create index model_credentials_by_key on model_credentials (key_fingerprint);

alter table model_credentials enable row level security;

-- The model a thread's agent runs on, as `provider/model`. Null for threads
-- created before each thread had one (they ran on the installation's single
-- model) until their owner chooses one. Adding a nullable column leaves a
-- control plane of the previous release, still serving during a redeploy,
-- unaffected.
alter table threads
  add column model text check (model ~ '^[a-z0-9][a-z0-9._-]{0,63}/[^[:space:]/][^[:space:]]*$'
    and char_length(model) <= 321);
