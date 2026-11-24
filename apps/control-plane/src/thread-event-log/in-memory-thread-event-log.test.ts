import { describeThreadEventLogContract } from "../test-support/thread-event-log-contract.js";
import { InMemoryThreadEventLog } from "./in-memory-thread-event-log.js";

describeThreadEventLogContract("InMemoryThreadEventLog", async () => new InMemoryThreadEventLog());
