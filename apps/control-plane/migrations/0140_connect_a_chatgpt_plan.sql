-- A user's ChatGPT plan, connected through OpenAI's "Sign in with ChatGPT"
-- programme so their threads' OpenAI requests run on it. Like every table
-- here, these live in the `barrack` schema with row level security on and
-- no policies (see 0001_create_thread_event_log.sql). This only adds
-- tables, so a control plane of the previous release, still serving during
-- a redeploy, is unaffected.

-- What OpenAI knows this installation by for each user who has begun a
-- sign-in, and what their threads spend on OpenAI models. `host_id` is the
-- stable `ext_agent_host_id` the programme asks for, one per user per
-- installation (`urn:uuid:` and a random UUID, identifying no one);
-- `client_id` the client OpenAI issued at the user's first sign-in, reused
-- for every later one, null until then. A plan connected before and lost
-- (OpenAI would not renew its sign-in) says why and when, until it is
-- connected again.
create table chatgpt_plans (
  user_id text primary key references users (user_id) on delete cascade,
  host_id text not null check (host_id ~ '^urn:uuid:[0-9a-f-]{36}$'),
  client_id text check (char_length(client_id) between 1 and 256),
  openai_access text not null default 'api_key'
    check (openai_access in ('api_key', 'chatgpt_plan')),
  loss_reason text check (loss_reason in ('sign_in_expired')),
  lost_at timestamptz,
  check ((loss_reason is null) = (lost_at is null))
);

alter table chatgpt_plans enable row level security;

-- The connected sign-in: its access and refresh tokens, never stored
-- readable. They are sealed together with AES-256-GCM under the same
-- configured key as users' model keys (see 0080_model_access.sql), bound to
-- their owner, so the database alone yields nothing. The refresh token
-- rotates: renewing it locks this row, and the replacement is written in
-- the same transaction as it is received, so there is one renewal at a
-- time per sign-in whichever control plane makes it.
create table chatgpt_plan_sign_ins (
  user_id text primary key references chatgpt_plans (user_id) on delete cascade,
  key_fingerprint text not null check (key_fingerprint ~ '^[0-9a-f]{16}$'),
  nonce bytea not null check (octet_length(nonce) = 12),
  -- The sealed tokens, then GCM's 16-byte authentication tag.
  ciphertext bytea not null check (octet_length(ciphertext) > 16),
  access_expires_at timestamptz not null,
  -- OpenAI's `earliest_refresh_at`, if it gave one.
  earliest_renewal_at timestamptz,
  -- The ChatGPT account, from its verified ID token: its subject, and its
  -- email address when OpenAI says it is verified.
  account_subject text not null check (char_length(account_subject) between 1 and 256),
  account_email text check (char_length(account_email) <= 320),
  connected_at timestamptz not null,
  renewed_at timestamptz not null
);

create index chatgpt_plan_sign_ins_by_key on chatgpt_plan_sign_ins (key_fingerprint);

alter table chatgpt_plan_sign_ins enable row level security;

-- Sign-ins begun and not yet finished, each found by the SHA-256 digest of
-- its `state`, so reading this table gives no state to finish one with.
-- The PKCE verifier and the ID token's nonce are sealed like the tokens
-- above. `client_id` is the one sent: `dynamic_agent_client` for a first
-- sign-in, or the issued client. A finished one is kept until it expires,
-- marked, so an address used twice is told apart from one never seen.
create table chatgpt_sign_in_attempts (
  state_digest bytea primary key check (octet_length(state_digest) = 32),
  user_id text not null references users (user_id) on delete cascade,
  client_id text not null check (char_length(client_id) between 1 and 256),
  redirect_uri text not null check (char_length(redirect_uri) <= 256),
  key_fingerprint text not null check (key_fingerprint ~ '^[0-9a-f]{16}$'),
  nonce bytea not null check (octet_length(nonce) = 12),
  ciphertext bytea not null check (octet_length(ciphertext) > 16),
  started_at timestamptz not null,
  expires_at timestamptz not null,
  finished_at timestamptz
);

-- Removing attempts long expired.
create index chatgpt_sign_in_attempts_by_expiry on chatgpt_sign_in_attempts (expires_at);

alter table chatgpt_sign_in_attempts enable row level security;
