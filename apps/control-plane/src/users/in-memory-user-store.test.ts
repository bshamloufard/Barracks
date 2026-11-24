import { describeUserStoreContract } from "../test-support/user-store-contract.js";
import { InMemoryUserStore } from "./in-memory-user-store.js";

describeUserStoreContract("InMemoryUserStore", async () => new InMemoryUserStore());
