import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type ResolverScript = "resolve-graduation" | "resolve-fdv";

export function assertDistinctArchiveProviders(primaryUrl?: string, secondaryUrl?: string) {
  if (!primaryUrl) throw new Error("ARCHIVE_RPC_URL is required for historical resolution and signing.");
  if (!secondaryUrl) throw new Error("SECONDARY_ARCHIVE_RPC_URL is required before a resolver can sign or the relay can submit.");
  let primaryHost: string;
  let secondaryHost: string;
  try {
    primaryHost = new URL(primaryUrl).host.toLowerCase();
    secondaryHost = new URL(secondaryUrl).host.toLowerCase();
  } catch {
    throw new Error("Primary and secondary archive RPC URLs must be valid absolute URLs.");
  }
  if (!primaryHost || !secondaryHost || primaryHost === secondaryHost) {
    throw new Error("Primary and secondary archive RPCs must use different provider hosts.");
  }
  return { primaryHost, secondaryHost };
}

/**
 * Replay the same deterministic historical resolver against a second archive
 * provider. Signing and relay fail closed unless both providers reproduce the
 * same evidence hash and EIP-712 digest.
 */
export function verifyOnSecondaryArchive(
  script: ResolverScript,
  marketId: string,
  expected: { evidenceHash: string; digest: string },
): void {
  const secondaryUrl = process.env.SECONDARY_ARCHIVE_RPC_URL;
  assertDistinctArchiveProviders(process.env.ARCHIVE_RPC_URL, secondaryUrl);
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ARCHIVE_RPC_URL: "",
    RPC_URL: secondaryUrl,
    SECONDARY_ARCHIVE_RPC_URL: "",
    SECONDARY_ARCHIVE_REPLAY: "1",
    RESOLVER_PRIVATE_KEY: "",
  };
  let output: string;
  try {
    output = execFileSync("npx", ["tsx", `src/${script}.ts`, marketId], {
      cwd,
      encoding: "utf8",
      env: childEnv,
      maxBuffer: 12 * 1024 * 1024,
    });
  } catch {
    throw new Error("Secondary archive resolver failed closed; verify provider connectivity and historical-state support.");
  }
  let secondary: { evidenceHash?: string; digest?: string };
  try {
    secondary = JSON.parse(output) as { evidenceHash?: string; digest?: string };
  } catch {
    throw new Error("Secondary archive resolver returned invalid JSON.");
  }
  if (secondary.evidenceHash?.toLowerCase() !== expected.evidenceHash.toLowerCase()
    || secondary.digest?.toLowerCase() !== expected.digest.toLowerCase()) {
    throw new Error("Primary and secondary archive providers disagree on historical evidence or attestation digest.");
  }
}
