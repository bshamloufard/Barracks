-- The control plane records how each publication of a thread's work branch
-- ended (pushed, or failed and why) as a thread event. Each publication has
-- an identifier the control plane mints when it starts, and this index is
-- what makes recording its outcome idempotent, as 0060 does for user
-- messages: a second insert for one publication, from a retry or from a
-- second control plane during a redeploy, fails with the whole append
-- statement (its counter update included, so no gap is left), and nothing
-- is recorded twice. A column of its own, not a json field, for the reason
-- given in 0060.
--
-- Numbered after the migrations written alongside it. It only adds a
-- nullable column and an index, so a control plane of the previous release,
-- still serving while the new one starts, is unaffected.
alter table thread_events
  add column publication_id text check (char_length(publication_id) between 1 and 256);

create unique index thread_events_one_per_publication
  on thread_events (thread_id, publication_id)
  where publication_id is not null;
