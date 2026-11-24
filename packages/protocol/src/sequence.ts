import { z } from "zod";

/**
 * A thread event's position in its thread. The control plane assigns it when
 * it stores the event: the first event of a thread is 1 and each later event
 * is one more than the previous, with no gaps. Clients rely on the absence of
 * gaps to know they have missed nothing.
 */
export const sequenceSchema = z.int().positive();
