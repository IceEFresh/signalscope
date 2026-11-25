import { execFileSync } from "node:child_process";

/**
 * Short commit for the report and log row. The harvester image has no git, so on the NAS pass
 * GIT_COMMIT (see the run command at the top); otherwise ask git; "unknown" rather than failing
 * a run after the work is done.
 */
export function commitId(): string {
  const env = process.env.GIT_COMMIT?.trim();
  if (env) return env.slice(0, 12);
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}
