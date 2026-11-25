/**
 * Supabase sends email codes of 6 to 10 digits, as its project's setting
 * says (`mailer_otp_length`; new projects have been seen to default to 8),
 * so the page accepts any of those lengths rather than one.
 */
export const shortestOneTimeCode = 6;
export const longestOneTimeCode = 10;

/** The same rule as an HTML `pattern`, for the code field. */
export const oneTimeCodePattern = `[0-9]{${shortestOneTimeCode},${longestOneTimeCode}}`;

const oneTimeCode = new RegExp(`^${oneTimeCodePattern}$`);

export function isOneTimeCode(code: string): boolean {
  return oneTimeCode.test(code);
}
