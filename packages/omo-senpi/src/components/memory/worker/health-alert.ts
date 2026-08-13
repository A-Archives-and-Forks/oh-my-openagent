import { safeNotify, type ReflectionLiveSession } from "./completion"
import { readReflectionHealth } from "./health"
import { reflectionRemediation } from "./remediation"

export const REFLECTION_HEALTH_ENTRY_TYPE = "senpi-memory.health"

export interface ReflectionHealthEntry {
  readonly schemaVersion: 1
  readonly identity: string
  readonly streak: number
  readonly fingerprint: string
  readonly lastReason: string
  readonly lastDetail?: string
  readonly sinceISO: string
  readonly recommendation: string
}

/**
 * Write side of reflection health: reads derived health, then appends a transcript entry and
 * notifies the session. Kept out of `./health` so that module stays purely derivational.
 */
export async function emitReflectionHealthAlert(
  completionsDir: string,
  identity: string,
  live: ReflectionLiveSession | undefined,
  once: (key: string) => boolean,
): Promise<boolean> {
  if (!live?.ui) return false
  const health = await readReflectionHealth(completionsDir)
  if (health.streak < 3 || health.fingerprint.length === 0) return false
  if (health.recentFailureFingerprints.filter((item) => item === health.fingerprint).length < 2) return false
  if (!once(`${live.sessionId}:${health.fingerprint}`)) return false
  const failure = health.lastFailure
  const recommendation = reflectionRemediation(failure?.reason, failure?.detail)
  const entry: ReflectionHealthEntry = {
    schemaVersion: 1,
    identity,
    streak: health.streak,
    fingerprint: health.fingerprint,
    lastReason: failure?.reason ?? "failed",
    ...(failure?.detail === undefined ? {} : { lastDetail: failure.detail }),
    sinceISO: health.streakSinceISO ?? failure?.finishedAt ?? new Date(0).toISOString(),
    recommendation,
  }
  live.api.appendEntry(REFLECTION_HEALTH_ENTRY_TYPE, entry)
  safeNotify(live, `Memory reflection has failed ${health.streak} times (${health.fingerprint}). ${recommendation}`, "warning")
  return true
}
