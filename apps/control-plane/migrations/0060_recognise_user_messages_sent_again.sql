-- A user message carries an identifier its client mints once and sends
-- again with every retry. A retry happens when the client was told the
-- message was not saved, which a database answer lost on its way back (a
-- timeout, a dropped connection) can tell it of a message that was saved
-- after all. This index is what makes recording a message idempotent: the
-- second insert of one message fails, the whole append statement with it
-- (its sequence counter update included, so no gap is left), and the
-- control plane answers with the message recorded the first time. As with
-- supervisor events, the identifier is a column of its own, since json
-- operators fail on events holding U+0000 (see 0001).
--
-- Messages recorded before this migration keep a null identifier: the
-- control plane minted their UUIDs, which no client will send again.
alter table thread_events
  add column user_message_id text check (char_length(user_message_id) between 1 and 256);

create unique index thread_events_one_per_user_message
  on thread_events (thread_id, user_message_id)
  where user_message_id is not null;
