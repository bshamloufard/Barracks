-- Since when a thread's sandbox has awaited its supervisor: set when the
-- sandbox is asked to be created or started, set again when it is recorded
-- running if no supervisor has attached meanwhile, and cleared when one
-- attaches. A sandbox running for long without its supervisor (a control
-- plane address it cannot reach, say) is stopped and its thread failed,
-- saying why; see apps/control-plane/src/sandbox-lifecycle/sandbox-reconciler.ts.
--
-- Threads that exist already are taken to have had their supervisor: an
-- unknown is not reported as a failure.
alter table threads add column awaiting_supervisor_since timestamptz;
