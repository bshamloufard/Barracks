/** The Supabase project whose Auth signs users in to this installation. */
export type SupabaseProject = {
  /** The project URL, such as `https://<project-ref>.supabase.co`, without a trailing slash. */
  url: string;
  /** Public by design: clients are handed it to sign in. */
  publishableKey: string;
  /** The `iss` claim its access tokens carry: normally the project URL with `/auth/v1`. */
  issuer: string;
};

/**
 * Where Supabase Auth publishes the public keys its access tokens are signed
 * with. It lists no keys for a project still signing with the legacy shared
 * secret. https://supabase.com/docs/guides/auth/jwts
 */
export function signingKeySetUrlOf(project: SupabaseProject): URL {
  return new URL(`${project.url}/auth/v1/.well-known/jwks.json`);
}

/** Supabase Auth's endpoint describing the user a token belongs to. */
export function userEndpointUrlOf(project: SupabaseProject): URL {
  return new URL(`${project.url}/auth/v1/user`);
}
