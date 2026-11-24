-- The model proxy reads the start of a thread's open run (the newest
-- `agent_run_started`) for every request naming a model other than the
-- thread's own, and every 30 seconds for a request on the model before a
-- switch. Without an index that read walks back along every event since
-- the run began, and the agent decides how many there are. This partial
-- index holds the run starts alone, so the read is one step whatever
-- follows.
--
-- It is on the event as stored, not on `event ->> 'type'`: an event is
-- `json`, kept as the text written (`{"type":"agent_run_started"}`, as the
-- control plane writes it), and Postgres refuses to take a field out of
-- one holding a `\u0000` escape, which would make appending such an event
-- fail. An index rather than a column on the counter row, which the
-- append statement would have to keep in step: a control plane of the
-- previous release, still appending during a redeploy, would leave such a
-- column stale, while it keeps an index up to date without knowing of it.
create index thread_events_run_starts on thread_events (thread_id, sequence desc)
  where event::text like '{"type":"agent_run_started"}'
    or event::text like '{"type":"agent_run_started",%';
