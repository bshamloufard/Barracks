import { describe, expect, it } from "vitest";
import { describeSignInEmailFailure } from "./sign-in-email-failure";

describe("what the page says when no sign-in email is sent", () => {
  it("says the project may send no more for now, what still works, and who can lift the limit", () => {
    const words = describeSignInEmailFailure(
      "over_email_send_rate_limit",
      "email rate limit exceeded",
    );

    expect(words).toBe(
      'No email was sent: this installation\'s email sender has sent as many emails as it may for now. An email you already have still works: open its link in this browser, if it is the newest you asked for here, or enter its code under "I already have an email". Otherwise, try again later. Whoever runs this installation can lift the limit by giving Supabase an email sender of its own.',
    );
  });

  it("says how long to wait when the address asked moments ago", () => {
    const words = describeSignInEmailFailure(
      "over_email_send_rate_limit",
      "For security purposes, you can only request this after 42 seconds.",
    );

    expect(words).toBe(
      "No email was sent: an address can ask for another only after a short wait. Try again in 42 seconds; an email asked for moments ago may still be on its way.",
    );
  });

  it("quotes Supabase for any other refusal", () => {
    expect(describeSignInEmailFailure("email_address_invalid", "Email address is invalid")).toBe(
      "Could not send the email: Email address is invalid",
    );
    expect(describeSignInEmailFailure(undefined, "Failed to fetch")).toBe(
      "Could not send the email: Failed to fetch",
    );
  });
});
