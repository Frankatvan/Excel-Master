import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { authOptions } from "../pages/api/auth/[...nextauth]";
import { consumeEmailOtp } from "@/lib/auth-otp";

jest.mock("next-auth", () => jest.fn(() => "next-auth-handler"));
jest.mock("next-auth/providers/google", () => jest.fn((config) => ({ id: "google", ...config })));
jest.mock("next-auth/providers/credentials", () => jest.fn((config) => ({ id: "email-otp", ...config })));

jest.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn(() => ({ mocked: true })),
    },
    drive: jest.fn(),
  },
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(),
}));

jest.mock("@/lib/auth-otp", () => ({
  consumeEmailOtp: jest.fn(),
}));

const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
const mockDrive = google.drive as jest.Mock;
const mockConsumeEmailOtp = consumeEmailOtp as jest.MockedFunction<typeof consumeEmailOtp>;

function buildSupabaseClient({
  cachedUser = null,
  upsertError = null,
}: {
  cachedUser?: { email: string } | null;
  upsertError?: Error | null;
} = {}) {
  const single = jest.fn().mockResolvedValue({ data: cachedUser });
  const eq = jest.fn(() => ({ single }));
  const select = jest.fn(() => ({ eq }));
  const upsert = jest.fn().mockResolvedValue({ error: upsertError });
  const from = jest.fn((table: string) => {
    if (table === "whitelisted_users") {
      return { select, upsert };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  return {
    client: { from },
    spies: { from, select, eq, single, upsert },
  };
}

async function loadSignInCallback() {
  return authOptions.callbacks.signIn;
}

describe("NextAuth signIn callback", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      GOOGLE_SHEET_ID: "test-sheet-id",
      GOOGLE_CLIENT_EMAIL: "service-account@example.com",
      GOOGLE_PRIVATE_KEY: "line1\\nline2",
      NEXT_PUBLIC_SUPABASE_URL: "http://test-supabase-url",
      SUPABASE_SERVICE_ROLE_KEY: "test-supabase-service-key",
      NEXTAUTH_SECRET: "test-secret",
    };
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("allows users already cached in whitelisted_users without calling Drive", async () => {
    const { client, spies } = buildSupabaseClient({
      cachedUser: { email: "cached@example.com" },
    });
    mockCreateClient.mockReturnValue(client as never);

    const signIn = await loadSignInCallback();
    const result = await signIn({ user: { email: "cached@example.com" } });

    expect(result).toBe(true);
    expect(spies.select).toHaveBeenCalledWith("email");
    expect(mockDrive).not.toHaveBeenCalled();
    expect(spies.upsert).not.toHaveBeenCalled();
  });

  it("caches the user when Google Drive permissions contain the email", async () => {
    const { client, spies } = buildSupabaseClient();
    const list = jest.fn().mockResolvedValue({
      data: {
        permissions: [{ emailAddress: "test@example.com", role: "writer" }],
      },
    });

    mockCreateClient.mockReturnValue(client as never);
    mockDrive.mockReturnValue({
      permissions: { list },
    });

    const signIn = await loadSignInCallback();
    const result = await signIn({ user: { email: "test@example.com" } });

    expect(result).toBe(true);
    expect(mockDrive).toHaveBeenCalledWith({
      version: "v3",
      auth: { mocked: true },
    });
    expect(list).toHaveBeenCalledWith({
      fileId: "test-sheet-id",
      fields: "permissions(emailAddress,role)",
    });
    expect(spies.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "test@example.com",
        last_synced_at: expect.any(String),
      }),
    );
  });

  it("rejects users that are not in the Google Sheet sharing list", async () => {
    const { client, spies } = buildSupabaseClient();
    const list = jest.fn().mockResolvedValue({
      data: {
        permissions: [{ emailAddress: "another@example.com", role: "reader" }],
      },
    });

    mockCreateClient.mockReturnValue(client as never);
    mockDrive.mockReturnValue({
      permissions: { list },
    });

    const signIn = await loadSignInCallback();
    const result = await signIn({ user: { email: "test@example.com" } });

    expect(result).toBe(false);
    expect(spies.upsert).not.toHaveBeenCalled();
  });

  it("fails closed when the cache upsert errors", async () => {
    const { client } = buildSupabaseClient({
      upsertError: new Error("supabase write failed"),
    });
    const list = jest.fn().mockResolvedValue({
      data: {
        permissions: [{ emailAddress: "test@example.com", role: "writer" }],
      },
    });

    mockCreateClient.mockReturnValue(client as never);
    mockDrive.mockReturnValue({
      permissions: { list },
    });

    const signIn = await loadSignInCallback();
    const result = await signIn({ user: { email: "test@example.com" } });

    expect(result).toBe(false);
  });

  it("registers an email-otp credentials provider for non-google inboxes", () => {
    expect(authOptions.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "email-otp",
          name: "Email OTP",
        }),
      ]),
    );
  });

  it("authorizes a shared non-gmail user through the email-otp provider", async () => {
    mockConsumeEmailOtp.mockResolvedValue({
      id: "shared@example.com",
      email: "shared@example.com",
      name: "shared@example.com",
    });

    const otpProvider = authOptions.providers.find((provider: { id: string }) => provider.id === "email-otp");
    const user = await otpProvider.authorize({
      email: "shared@example.com",
      code: "123456",
    });

    expect(mockConsumeEmailOtp).toHaveBeenCalledWith("shared@example.com", "123456");
    expect(user).toEqual({
      id: "shared@example.com",
      email: "shared@example.com",
      name: "shared@example.com",
    });
  });
});
