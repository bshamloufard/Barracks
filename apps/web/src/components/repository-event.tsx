import type { RepositoryEvent } from "@barrack/protocol";
import { describeRepositoryEvent } from "../presentation/describe-repository";

/** One thing that happened to the thread's repository, as the conversation shows it. */
export function RepositoryEventView({ event }: { event: RepositoryEvent }) {
  return (
    <>
      {describeRepositoryEvent(event).map((description) => (
        <p
          key={description.text}
          className={
            description.tone === "error"
              ? "error-notice"
              : `repository-note repository-note-${description.tone}`
          }
          role={description.tone === "error" ? "alert" : undefined}
        >
          {description.text}
          {description.link !== undefined && (
            <>
              {" "}
              <a href={description.link.url} target="_blank" rel="noreferrer">
                {description.link.label}
              </a>
            </>
          )}
        </p>
      ))}
    </>
  );
}
