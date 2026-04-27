function normalizeOrigin(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function resolveTrustedWorkerUrl(configuredUrl: string | undefined, workerPath: string) {
  const explicitUrl = configuredUrl?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  const trustedOrigin = normalizeOrigin(process.env.NEXTAUTH_URL || "") || normalizeOrigin(process.env.VERCEL_URL || "");
  if (!trustedOrigin) {
    return undefined;
  }

  try {
    return new URL(workerPath, trustedOrigin).toString();
  } catch {
    return undefined;
  }
}
