/**
 * How a supervisor's secrets reach it: as files, one per secret, named after
 * it, in a directory only the supervisor's user can enter, whose path the
 * supervisor reads from `BARRACK_SUPERVISOR_SECRETS_DIRECTORY`. Never as
 * environment variables, which every process started in the sandbox gets,
 * whoever it runs as, and which a provider shows to anyone who can inspect
 * the sandbox. A file outlives a stop and a start, as an environment does.
 */

/** The variable that tells the supervisor where its secrets are; each provider sets it itself. */
export const supervisorSecretsDirectoryVariable = "BARRACK_SUPERVISOR_SECRETS_DIRECTORY";

/**
 * Where Barrack's sandbox image keeps the supervisor's secrets: a directory
 * owned by the supervisor's user, mode 0700 (see sandbox-image/Dockerfile).
 */
export const sandboxImageSecretsDirectory = "/var/lib/barrack/secrets";

/** The supervisor's user in Barrack's sandbox image, which owns each secret's file. */
export const sandboxImageSupervisorUser = { name: "barrack-supervisor", id: 10_001 };

const tarBlockLength = 512;

/**
 * A tar archive of one file per secret, each named after its secret, owned
 * by `ownerId` (user and group) and readable by that owner alone (0400), to
 * be unpacked into the secrets directory. Only a provider that unpacks it as
 * a privileged process with the archive's ownership (Docker's
 * `PUT /containers/{id}/archive`, through `docker cp -`) needs this; the
 * names must already have been checked by `validateCreationRequest`, which
 * keeps them short and free of path separators.
 * https://www.gnu.org/software/tar/manual/html_node/Standard.html
 */
export function buildSecretsArchive(
  secrets: Readonly<Record<string, string>>,
  ownerId: number,
): Buffer {
  const entries = Object.entries(secrets).flatMap(([name, value]) => {
    const content = Buffer.from(value, "utf8");
    return [buildFileHeader(name, content.length, ownerId), padToBlock(content)];
  });
  // Two empty blocks end an archive.
  return Buffer.concat([...entries, Buffer.alloc(tarBlockLength * 2)]);
}

function buildFileHeader(name: string, size: number, ownerId: number): Buffer {
  const header = Buffer.alloc(tarBlockLength);
  const writeField = (value: string, offset: number, length: number): void => {
    header.write(value, offset, length, "ascii");
  };
  writeField(name, 0, 100);
  writeField(toOctalField(0o400, 8), 100, 8);
  writeField(toOctalField(ownerId, 8), 108, 8);
  writeField(toOctalField(ownerId, 8), 116, 8);
  writeField(toOctalField(size, 12), 124, 12);
  writeField(toOctalField(0, 12), 136, 12);
  // A regular file, in the POSIX ustar format.
  writeField("0", 156, 1);
  writeField("ustar\0", 257, 6);
  writeField("00", 263, 2);
  // The checksum is the sum of the header's bytes with its own field read as spaces.
  writeField(" ".repeat(8), 148, 8);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeField(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function toOctalField(value: number, fieldLength: number): string {
  return `${value.toString(8).padStart(fieldLength - 1, "0")}\0`;
}

function padToBlock(content: Buffer): Buffer {
  const remainder = content.length % tarBlockLength;
  return remainder === 0
    ? content
    : Buffer.concat([content, Buffer.alloc(tarBlockLength - remainder)]);
}
