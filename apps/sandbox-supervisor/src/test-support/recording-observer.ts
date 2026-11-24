import type { AgentEvent, StreamFragment } from "@barrack/protocol";
import type { AgentHarnessObserver, AgentProcessEnding } from "../agent-harness.js";

export type RecordedOutput =
  | { kind: "event"; event: AgentEvent }
  | { kind: "fragment"; fragment: StreamFragment };

/** Records everything a harness reports, in order. */
export class RecordingObserver implements AgentHarnessObserver {
  readonly outputs: RecordedOutput[] = [];
  readonly processEndings: AgentProcessEnding[] = [];

  onAgentEvent(event: AgentEvent): void {
    this.outputs.push({ kind: "event", event });
  }

  onStreamFragment(fragment: StreamFragment): void {
    this.outputs.push({ kind: "fragment", fragment });
  }

  onAgentProcessEnded(ending: AgentProcessEnding): void {
    this.processEndings.push(ending);
  }

  get events(): AgentEvent[] {
    return this.outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
  }

  get eventTypes(): string[] {
    return this.events.map((event) => event.type);
  }

  /** Event types with fragments shown as `fragment`, to check how they interleave. */
  get outputTypes(): string[] {
    return this.outputs.map((output) => (output.kind === "event" ? output.event.type : "fragment"));
  }

  countEvents(type: AgentEvent["type"]): number {
    return this.events.filter((event) => event.type === type).length;
  }
}
