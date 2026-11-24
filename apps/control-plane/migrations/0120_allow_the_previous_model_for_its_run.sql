-- When a thread's model is switched while a run is open, the run carries on
-- with the model it began with until it ends, so the model proxy goes on
-- relaying that one model for that one run, for at most a bounded time.
-- One row per thread at most: the model before the switch, the run it is
-- allowed for (by the sequence of the `agent_run_started` that began it,
-- recorded by the control plane at the switch), and until when. Only this
-- adds a table, so a control plane of the previous release, still serving
-- during a redeploy, is unaffected.
create table model_switch_allowances (
  thread_id text primary key references threads (thread_id) on delete cascade,
  previous_model text not null check (char_length(previous_model) between 3 and 321),
  run_started_at_sequence bigint not null check (run_started_at_sequence > 0),
  allowed_until timestamptz not null
);

alter table model_switch_allowances enable row level security;
