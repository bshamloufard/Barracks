-- What the control plane needs to stop, start, wake, delete and reconcile
-- threads' sandboxes, and to list threads by their latest activity. The
-- lifecycle these columns describe is explained in
-- apps/control-plane/src/sandbox-lifecycle/sandbox-lifecycle.ts.

-- The states a sandbox can be in. `ready` becomes `running`. Every change of
-- state is a conditional update on `state_version`, which each change
-- increases, so of two control planes (or two requests) acting on what they
-- both read, exactly one succeeds.
--   creating, starting, stopping, deleting: a provider operation is under
--     way, by whichever control plane holds the lease until
--     `lease_expires_at`; once that passes without being renewed, another
--     takes the operation over.
--   running, stopped: settled; `sandbox_problem` may say why the last
--     attempt to change that failed.
--   failed: `sandbox_failure_reason` says why; with a `sandbox_id` it can
--     be started again, without one it is gone.
alter table threads drop constraint threads_sandbox_state_check;
alter table threads drop constraint threads_check;
alter table threads drop constraint threads_check1;

update threads set sandbox_state = 'running' where sandbox_state = 'ready';

alter table threads
  add column state_version bigint not null default 1 check (state_version > 0),
  add column lease_expires_at timestamptz,
  add column sandbox_problem text check (sandbox_problem <> ''),
  add column wake_requested boolean not null default false,
  -- Derived from the first user message (see thread-title.ts); null until
  -- there is one.
  add column title text check (title <> '' and char_length(title) <= 200),
  add column last_activity_at timestamptz;

-- A creation under way when this migration runs was started by a control
-- plane that has since stopped; an expired lease lets the next one finish it.
update threads set lease_expires_at = now() where sandbox_state = 'creating';
-- Milliseconds, as the control plane writes every time it records: idle
-- shutdown compares the time it read with the stored one exactly.
update threads set last_activity_at = date_trunc('milliseconds', created_at);
alter table threads alter column last_activity_at set not null;

alter table threads
  add constraint threads_sandbox_state_is_known check (sandbox_state in (
    'creating', 'running', 'stopping', 'stopped', 'starting', 'failed', 'deleting'
  )),
  add constraint threads_sandbox_id_matches_state check (
    case sandbox_state
      when 'creating' then sandbox_id is null
      when 'running' then sandbox_id is not null
      when 'stopping' then sandbox_id is not null
      when 'stopped' then sandbox_id is not null
      when 'starting' then sandbox_id is not null
      else true
    end
  ),
  add constraint threads_failure_reason_only_when_failed check (
    (sandbox_state = 'failed') = (sandbox_failure_reason is not null)
  ),
  add constraint threads_lease_only_while_operating check (
    (sandbox_state in ('creating', 'starting', 'stopping', 'deleting')) = (lease_expires_at is not null)
  ),
  add constraint threads_problem_only_when_settled check (
    sandbox_problem is null or sandbox_state in ('running', 'stopped')
  );

-- The thread list reads one user's threads, most recently active first.
create index threads_most_recently_active_by_owner
  on threads (owner_user_id, last_activity_at desc, thread_id desc);
drop index threads_newest_first_by_owner;

-- Reconciliation and idle shutdown look threads up by state.
create index threads_by_sandbox_state on threads (sandbox_state);

-- The sequence of each thread's newest user message, kept by the same
-- append that records it, so whether one is still waiting to be delivered
-- (it is after `user_messages_delivered_through`) is known without reading
-- events. Existing history is read once here: an event's stored text starts
-- with its type, as the control plane writes it, which avoids json
-- operators (they fail on events holding U+0000; see 0001).
alter table thread_sequence_counters
  add column last_user_message_sequence bigint not null default 0
    check (last_user_message_sequence >= 0);

update thread_sequence_counters as counter
  set last_user_message_sequence = coalesce((
    select max(sequence) from thread_events
    where thread_events.thread_id = counter.thread_id
      and event::text like '{"type":"user_message"%'
  ), 0);
