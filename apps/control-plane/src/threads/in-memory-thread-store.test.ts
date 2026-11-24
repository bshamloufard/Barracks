import { describeThreadStoreContract } from "../test-support/thread-store-contract.js";
import { InMemoryThreadStore } from "./in-memory-thread-store.js";

describeThreadStoreContract("InMemoryThreadStore", async () => new InMemoryThreadStore());
