import type { NextApiRequest, NextApiResponse } from "next";

import handler from "../pages/api/debug-env";

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  return res as NextApiResponse;
}

describe("/api/debug-env", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns masked oauth settings and worker credential presence flags", () => {
    process.env.GOOGLE_CLIENT_ID = "795170506031-8h9u1s8tdakiltf8dbjvbfk0uhlpgsce.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.NEXTAUTH_URL = "https://audit.frankzh.top";
    process.env.GOOGLE_CREDENTIALS_JSON = '{"type":"service_account"}';
    process.env.GOOGLE_PROJECT_ID = "project-id";
    process.env.GOOGLE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----";
    process.env.GOOGLE_CLIENT_EMAIL = "worker@example.iam.gserviceaccount.com";
    process.env.RECLASSIFY_WORKER_URL = "https://worker.example.com/api/reclassify_job";
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef1234567890";
    process.env.VERCEL_ENV = "production";

    const req = {} as NextApiRequest;
    const res = createMockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      clientId: "7951705060...t.com",
      hasSecret: true,
      nextAuthUrl: "https://audit.frankzh.top",
      hasServiceAccountJson: true,
      hasGoogleProjectId: true,
      hasGooglePrivateKey: true,
      hasGoogleClientEmail: true,
      hasWorkerUrlOverride: true,
      deploymentCommit: "abcdef12",
      vercelEnv: "production",
    });
  });
});
