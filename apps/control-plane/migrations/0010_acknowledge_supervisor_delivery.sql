-- What acknowledged delivery between a thread's supervisor and the control
-- plane needs the database to keep. The handshake and its guarantees are
-- described in packages/protocol/src/supervisor-messages.ts.
--
-- Numbered 0010 rather than 0003 so it cannot collide with migrations being
-- written alongside it; the runner applies files in name order, and needs no
-- gapless numbering.

-- Where each agent event came from: the supervisor process that sent it (an
-- identifier it mints each time it starts) and its number among that
-- process's events. Events the control plane originates (user messages, and
-- the end of a run nobody else can end) have neither.
alter table thread_events
  add column supervisor_instance_id text
    check (char_length(supervisor_instance_id) between 1 and 256),
  add column supervisor_event_number bigint check (supervisor_event_number > 0),
  add check ((supervisor_instance_id is null) = (supervisor_event_number is null));

-- A supervisor sends an event again whenever it has not heard that it was
-- recorded, and two control plane instances can both be recording one
-- thread for a moment. This index is what makes recording idempotent: the
-- second insert of one event fails, the whole append statement with it (its
-- sequence counter update included, so no gap is left), and the control
-- plane reports the event as already recorded. It also answers "the last
-- event recorded from this instance" without reading the events.
create unique index thread_events_one_per_supervisor_event
  on thread_events (thread_id, supervisor_instance_id, supervisor_event_number)
  where supervisor_instance_id is not null;

-- Kept on each thread's counter row, which every append already updates:
-- - open_run_supervisor_instance_id: the supervisor instance whose run is
--   open (its agent_run_started is the last run boundary recorded), or null
--   when none is. Set and cleared by the append that records the boundary,
--   so it always agrees with the history.
-- - user_messages_delivered_through: the sequence through which user
--   messages have been handed to an agent, as acknowledged by supervisors.
--   It only grows.
alter table thread_sequence_counters
  add column open_run_supervisor_instance_id text
    check (char_length(open_run_supervisor_instance_id) between 1 and 256),
  add column user_messages_delivered_through bigint not null default 0
    check (user_messages_delivered_through >= 0);

-- History recorded before this migration was delivered as it was recorded,
-- and nothing remembers which supervisor started a run still open in it, so
-- the control plane never closes such a run itself.
update thread_sequence_counters set user_messages_delivered_through = last_sequence;
