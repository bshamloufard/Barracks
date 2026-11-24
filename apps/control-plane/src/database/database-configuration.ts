import { z } from "zod";

/**
 * Supabase's session pooler serves at most "Pool Size" connections (15 by
 * default) per database role and database, shared by everything using that
 * role. Railway briefly runs two control plane instances during a redeploy,
 * so five each leaves room for both and for a person with `psql` open.
 * https://supabase.com/docs/guides/platform/compute-and-disk#limits-and-constraints
 */
const defaultPoolSize = 5;

/**
 * Supabase pauses a free project after a week without "sufficient user
 * database activity", and says "a few user requests to the database each
 * day" are typically enough, so six a day leaves a wide margin; see
 * database-keep-alive.ts.
 */
const defaultKeepAliveIntervalInMinutes = 240;
const longestKeepAliveIntervalInMinutes = 24 * 60;

/**
 * `verify-full`, as in libpq, encrypts and checks both that the server's
 * certificate chains to a trusted authority and that it names the host
 * connected to. `disable` sends everything, the password included, in the
 * clear, so it exists only for a database on the same machine or private
 * network, and the control plane warns whenever it is used.
 */
const tlsModes = ["verify-full", "disable"] as const;

export type DatabaseTlsMode = (typeof tlsModes)[number];

export type DatabaseConfiguration = {
  host: string;
  port: number;
  databaseName: string;
  user: string;
  /** Never logged. */
  password: string;
  tlsMode: DatabaseTlsMode;
  /**
   * PEM certificates of the authorities to trust instead of the ones Node
   * trusts by default. Supabase signs its database certificates with its own
   * authority, so this is required there; see the README.
   */
  certificateAuthorities: string | undefined;
  poolSize: number;
  /** How often to query the database so that an idle free Supabase project is not paused; undefined when off. */
  keepAliveIntervalInMilliseconds: number | undefined;
};

/** The parts of a database URL that may safely appear in logs. */
export type DatabaseLocation = Pick<DatabaseConfiguration, "host" | "port" | "databaseName">;

/**
 * Settings in a URL's query string, such as `sslmode`, would be read by the
 * driver and silently replace the TLS settings below (see
 * https://node-postgres.com/features/ssl), so the URL may not carry any.
 * Messages never repeat the URL, because it holds the password.
 */
const databaseUrlSchema = z
  .string()
  .refine(isPostgresUrl, {
    error: "must be a postgres:// or postgresql:// URL naming a host and a database",
  })
  .refine((url) => new URL(url).search === "", {
    error:
      "must not contain query parameters; TLS is set with BARRACK_DATABASE_TLS and BARRACK_DATABASE_CA_CERTIFICATE",
  });

/** The environment variables that configure the database, shared by the server and the migration script. */
export const databaseEnvironmentShape = {
  BARRACK_DATABASE_URL: databaseUrlSchema.optional(),
  BARRACK_DATABASE_TLS: z.enum(tlsModes).default("verify-full"),
  BARRACK_DATABASE_CA_CERTIFICATE: z
    .string()
    .refine((pem) => pem.includes("-----BEGIN CERTIFICATE-----"), {
      error: "must hold one or more PEM certificates",
    })
    .optional(),
  BARRACK_DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(defaultPoolSize),
  /** 0 turns the keep-alive off. */
  BARRACK_DATABASE_KEEP_ALIVE_MINUTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(longestKeepAliveIntervalInMinutes)
    .default(defaultKeepAliveIntervalInMinutes),
};

const databaseEnvironmentSchema = z.object(databaseEnvironmentShape);

type DatabaseSettings = z.infer<typeof databaseEnvironmentSchema>;

/** Returns undefined when no database URL is set, which selects the in-memory log. */
export function toDatabaseConfiguration(
  settings: DatabaseSettings,
): DatabaseConfiguration | undefined {
  if (settings.BARRACK_DATABASE_URL === undefined) {
    return undefined;
  }
  const url = new URL(settings.BARRACK_DATABASE_URL);
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port === "" ? 5432 : Number(url.port),
    databaseName: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    tlsMode: settings.BARRACK_DATABASE_TLS,
    certificateAuthorities: settings.BARRACK_DATABASE_CA_CERTIFICATE,
    poolSize: settings.BARRACK_DATABASE_POOL_SIZE,
    keepAliveIntervalInMilliseconds:
      settings.BARRACK_DATABASE_KEEP_ALIVE_MINUTES === 0
        ? undefined
        : settings.BARRACK_DATABASE_KEEP_ALIVE_MINUTES * 60_000,
  };
}

export type DatabaseConfigurationResult =
  | { ok: true; configuration: DatabaseConfiguration | undefined }
  | { ok: false; problems: string[] };

/** Reads only the database settings, for tools such as the migration script that need nothing else. */
export function readDatabaseConfiguration(
  environment: NodeJS.ProcessEnv,
): DatabaseConfigurationResult {
  const validation = databaseEnvironmentSchema.safeParse(environment);
  if (!validation.success) {
    return { ok: false, problems: describeProblems(validation.error) };
  }
  return { ok: true, configuration: toDatabaseConfiguration(validation.data) };
}

export function locationOf(configuration: DatabaseConfiguration): DatabaseLocation {
  return {
    host: configuration.host,
    port: configuration.port,
    databaseName: configuration.databaseName,
  };
}

export function describeProblems(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

function isPostgresUrl(text: string): boolean {
  if (!URL.canParse(text)) {
    return false;
  }
  const url = new URL(text);
  const isPostgresScheme = url.protocol === "postgres:" || url.protocol === "postgresql:";
  return isPostgresScheme && url.hostname !== "" && url.pathname.length > 1;
}
