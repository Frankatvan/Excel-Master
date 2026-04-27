interface GoogleServiceAccountCredentials {
  client_email: string;
  private_key: string;
  project_id?: string;
}

function readCredentialsFromJson() {
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!raw?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      client_email?: unknown;
      private_key?: unknown;
      project_id?: unknown;
    };

    if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
      return null;
    }

    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key.replace(/\\n/g, "\n"),
      project_id: typeof parsed.project_id === "string" ? parsed.project_id : undefined,
    } satisfies GoogleServiceAccountCredentials;
  } catch (error) {
    throw new Error(
      `GOOGLE_CREDENTIALS_JSON 解析失败: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function readCredentialsFromSplitEnv() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const projectId = process.env.GOOGLE_PROJECT_ID?.trim();

  if (!clientEmail || !privateKey) {
    return null;
  }

  return {
    client_email: clientEmail,
    private_key: privateKey,
    project_id: projectId || undefined,
  } satisfies GoogleServiceAccountCredentials;
}

export function getGoogleServiceAccountCredentials(): GoogleServiceAccountCredentials {
  const jsonCredentials = readCredentialsFromJson();
  if (jsonCredentials) {
    return jsonCredentials;
  }

  const splitCredentials = readCredentialsFromSplitEnv();
  if (splitCredentials) {
    return splitCredentials;
  }

  throw new Error("Google service account credentials are missing.");
}
