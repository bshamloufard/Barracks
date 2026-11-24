-- Working with a Git repository: the repository each thread started from,
-- what publishing its work branch did, and which GitHub account and
-- repositories each user linked through the installation's GitHub App.
-- Like every table here, they live in the `barrack` schema with row level
-- security on and no policies (see 0001_create_thread_event_log.sql).
--
-- None of these hold a credential. GitHub tokens are minted when needed and
-- never stored; the user's own GitHub token is discarded as soon as their
-- repositories have been read. The verifier of a sign-in with GitHub that
-- is under way is kept for at most ten minutes, and is worthless without
-- the code GitHub hands only to the user's browser.

-- One row per thread that started from a repository, written in the same
-- transaction as the thread, and removed with it.
create table thread_repositories (
  thread_id text primary key references threads (thread_id) on delete cascade,
  url text not null check (url <> '' and char_length(url) <= 2048),
  access text not null check (access in ('none', 'github_app')),
  -- Null means the repository's default branch.
  base_branch text check (base_branch <> '' and char_length(base_branch) <= 255),
  work_branch text not null check (work_branch <> '' and char_length(work_branch) <= 255),
  github_repository_id bigint,
  github_installation_id bigint,
  github_full_name text,
  github_html_url text,
  last_published_commit text check (last_published_commit ~ '^[0-9a-f]{40}$'),
  pull_request_number integer check (pull_request_number > 0),
  pull_request_url text,
  constraint thread_repositories_github_only_with_github_app check (
    (access = 'github_app') = (
      github_repository_id is not null and github_installation_id is not null
      and github_full_name is not null and github_html_url is not null
      and base_branch is not null
    )
  ),
  constraint thread_repositories_pull_request_whole check (
    (pull_request_number is null) = (pull_request_url is null)
  )
);

alter table thread_repositories enable row level security;

-- A user's link to their GitHub account: who they are on GitHub, and the
-- repositories they were verified, by asking GitHub with their own
-- authorisation, to be able to push to and that the App is installed on.
-- `repositories` is a JSON array, read and replaced whole.
create table github_connections (
  user_id text primary key references users (user_id) on delete cascade,
  github_user_id bigint not null,
  github_login text not null check (github_login <> ''),
  github_name text,
  connected_at timestamptz not null,
  repositories json not null
);

alter table github_connections enable row level security;

-- A sign-in with GitHub under way: the SHA-256 digest of the `state` sent
-- to GitHub, which user started it, and the PKCE verifier to finish it
-- with. Each is used at most once, by the same user, before it expires.
create table github_connection_attempts (
  state_digest bytea primary key check (octet_length(state_digest) = 32),
  user_id text not null references users (user_id) on delete cascade,
  code_verifier text not null,
  expires_at timestamptz not null
);

create index github_connection_attempts_by_user on github_connection_attempts (user_id);

alter table github_connection_attempts enable row level security;
