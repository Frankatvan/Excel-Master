import { normalizeAccessEmail, verifyAnyProjectAccess } from "@/lib/project-access";

export function normalizeEmail(email: string) {
  return normalizeAccessEmail(email);
}

export async function verifySheetAccess(email: string): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return false;
  }

  try {
    const hasProjectAccess = await verifyAnyProjectAccess(normalizedEmail);
    if (!hasProjectAccess) {
      console.warn(`[Auth] Access DENIED for ${normalizedEmail}: No registered project permissions.`);
      return false;
    }

    return true;
  } catch (error) {
    console.error(
      `[Auth] verifySheetAccess failed for ${normalizedEmail}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return false;
  }
}
