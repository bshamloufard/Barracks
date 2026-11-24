-- The tokens a thread's sandbox may hold. A creation taken over from a
-- control plane that has gone mints a new supervisor token, since the
-- earlier one was never stored, and records its digest before asking the
-- provider, so that a sandbox made with it is let in. But the provider may
-- instead turn up a sandbox an earlier attempt made, holding an earlier
-- token, and which attempt made it cannot be known. So a thread accepts
-- every token minted for its creation: `supervisor_token_digest`, minted
-- with the thread, and one more here for each take-over. Each token only
-- ever went to this thread's sandbox, through the provider.
--
-- Numbered 0050, not 0040, to leave room for migrations written alongside.
-- It only adds a column with a default, so a control plane of the previous
-- release, still serving while the new one starts, is unaffected.
alter table threads
  add column taken_over_supervisor_token_digests bytea[] not null default '{}';
