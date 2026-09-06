// Pure, side-effect-free guards for the DB migration endpoint. Extracted from
// the route handler so the SSRF allowlist logic is unit-testable without
// standing up the full request/auth/DB stack.

/** Parse the comma-separated MIGRATE_ALLOWED_HOSTS env value into a clean list. */
export function parseAllowedHosts(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0)
}

export type MigrateSourceCheck =
  | { ok: true; host: string }
  | { ok: false; status: number; error: string }

/**
 * Validate an attacker-controllable source connection URL against the host
 * allowlist. Fails CLOSED: an unset/empty allowlist rejects everything.
 */
export function checkMigrateSource(
  sourceUrl: unknown,
  allowedHostsRaw: string | undefined | null,
): MigrateSourceCheck {
  if (typeof sourceUrl !== "string" || !sourceUrl.startsWith("postgres")) {
    return { ok: false, status: 400, error: "bad source url" }
  }

  const allowedHosts = parseAllowedHosts(allowedHostsRaw)
  if (allowedHosts.length === 0) {
    return {
      ok: false,
      status: 403,
      error: "migration disabled: MIGRATE_ALLOWED_HOSTS is not configured",
    }
  }

  let host: string
  try {
    host = new URL(sourceUrl).hostname.toLowerCase()
  } catch {
    return { ok: false, status: 400, error: "bad source url" }
  }

  if (!host || !allowedHosts.includes(host)) {
    return { ok: false, status: 403, error: `source host not allowed: ${host || "(none)"}` }
  }

  return { ok: true, host }
}
