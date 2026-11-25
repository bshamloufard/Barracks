/**
 * What the page says when Supabase will not send a sign-in email. Supabase
 * Auth refuses with `over_email_send_rate_limit` in two cases, told apart
 * only by the message (`internal/api/mail.go` in supabase/auth): the
 * project's email sender has sent as many emails as it may for now ("email
 * rate limit exceeded"; Supabase's built-in sender allows two an hour for
 * the whole project, and only custom SMTP raises it), or this address asked
 * for one moments ago ("For security purposes, you can only request this
 * after N seconds."). Supabase's words are not shown for either: they would
 * not say what the user can do.
 * https://supabase.com/docs/guides/auth/debugging/error-codes
 */
export function describeSignInEmailFailure(errorCode: string | undefined, message: string): string {
  if (errorCode !== "over_email_send_rate_limit") {
    return `Could not send the email: ${message}`;
  }
  const secondsToWait = /after (\d+) seconds?/.exec(message)?.[1];
  if (secondsToWait !== undefined) {
    return `No email was sent: an address can ask for another only after a short wait. Try again in ${secondsToWait} seconds; an email asked for moments ago may still be on its way.`;
  }
  return 'No email was sent: this installation\'s email sender has sent as many emails as it may for now. An email you already have still works: open its link in this browser, if it is the newest you asked for here, or enter its code under "I already have an email". Otherwise, try again later. Whoever runs this installation can lift the limit by giving Supabase an email sender of its own.';
}
