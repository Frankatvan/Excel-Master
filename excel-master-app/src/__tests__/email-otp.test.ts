import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

import { consumeEmailOtp, requestEmailOtp } from "@/lib/auth-otp";
import { verifySheetAccess } from "@/lib/auth-access";

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(),
}));

jest.mock("nodemailer", () => ({
  createTransport: jest.fn(),
}));

jest.mock("@/lib/auth-access", () => ({
  verifySheetAccess: jest.fn(),
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
}));

const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
const mockCreateTransport = nodemailer.createTransport as jest.Mock;
const mockVerifySheetAccess = verifySheetAccess as jest.MockedFunction<typeof verifySheetAccess>;

function buildOtpSupabaseClient({
  otpRecord = null,
}: {
  otpRecord?: Record<string, unknown> | null;
} = {}) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: otpRecord, error: null });
  const eq = jest.fn(() => ({ maybeSingle }));
  const select = jest.fn(() => ({ eq }));
  const upsert = jest.fn().mockResolvedValue({ error: null });
  const updateEq = jest.fn().mockResolvedValue({ error: null });
  const update = jest.fn(() => ({ eq: updateEq }));
  const from = jest.fn((table: string) => {
    if (table === "email_login_otps") {
      return { select, upsert, update };
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  return {
    client: { from },
    spies: { from, select, eq, maybeSingle, upsert, update, updateEq },
  };
}

describe("email otp helpers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "http://test-supabase-url",
      SUPABASE_SERVICE_ROLE_KEY: "test-supabase-service-key",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_USER: "mailer",
      SMTP_PASS: "secret",
      EMAIL_OTP_FROM: "AiWB <no-reply@example.com>",
      EMAIL_OTP_TTL_MINUTES: "10",
      EMAIL_OTP_RESEND_COOLDOWN_SECONDS: "60",
      EMAIL_OTP_MAX_ATTEMPTS: "5",
    };
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("sends a one-time code to a shared email and stores only the hashed secret", async () => {
    const { client, spies } = buildOtpSupabaseClient();
    const sendMail = jest.fn().mockResolvedValue({ messageId: "msg-1" });

    mockVerifySheetAccess.mockResolvedValue(true);
    mockCreateClient.mockReturnValue(client as never);
    mockCreateTransport.mockReturnValue({ sendMail });

    const result = await requestEmailOtp("shared@example.com");

    expect(result.email).toBe("shared@example.com");
    expect(mockVerifySheetAccess).toHaveBeenCalledWith("shared@example.com");
    expect(spies.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "shared@example.com",
        code_hash: expect.any(String),
        attempt_count: 0,
        consumed_at: null,
      }),
      { onConflict: "email" },
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "shared@example.com",
        from: "AiWB <no-reply@example.com>",
      }),
    );
  });

  it("rejects otp requests for emails outside the sheet sharing list", async () => {
    const { client } = buildOtpSupabaseClient();

    mockVerifySheetAccess.mockResolvedValue(false);
    mockCreateClient.mockReturnValue(client as never);

    await expect(requestEmailOtp("outsider@example.com")).rejects.toThrow(
      "Email is not authorized for this workbook.",
    );
  });

  it("consumes a valid one-time code exactly once", async () => {
    const { client, spies } = buildOtpSupabaseClient({
      otpRecord: {
        email: "shared@example.com",
        code_hash: "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
        expires_at: "2099-04-21T12:00:00.000Z",
        requested_at: "2099-04-21T11:50:00.000Z",
        consumed_at: null,
        attempt_count: 0,
      },
    });

    mockVerifySheetAccess.mockResolvedValue(true);
    mockCreateClient.mockReturnValue(client as never);

    const user = await consumeEmailOtp("shared@example.com", "password");

    expect(user).toEqual({
      id: "shared@example.com",
      email: "shared@example.com",
      name: "shared@example.com",
    });
    expect(spies.update).toHaveBeenCalledWith(
      expect.objectContaining({
        consumed_at: expect.any(String),
      }),
    );
  });

  it("increments attempts and rejects a wrong one-time code", async () => {
    const { client, spies } = buildOtpSupabaseClient({
      otpRecord: {
        email: "shared@example.com",
        code_hash: "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
        expires_at: "2099-04-21T12:00:00.000Z",
        requested_at: "2099-04-21T11:50:00.000Z",
        consumed_at: null,
        attempt_count: 1,
      },
    });

    mockVerifySheetAccess.mockResolvedValue(true);
    mockCreateClient.mockReturnValue(client as never);

    const user = await consumeEmailOtp("shared@example.com", "wrong-code");

    expect(user).toBeNull();
    expect(spies.update).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt_count: 2,
      }),
    );
  });
});
