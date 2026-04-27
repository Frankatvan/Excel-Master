import { authOptions } from "../pages/api/auth/[...nextauth]";
import { consumeEmailOtp } from "@/lib/auth-otp";
import { verifyAnyProjectAccess } from "@/lib/project-access";

jest.mock("next-auth", () => jest.fn(() => "next-auth-handler"));
jest.mock("next-auth/providers/google", () => jest.fn((config) => ({ id: "google", ...config })));
jest.mock("next-auth/providers/credentials", () => jest.fn((config) => ({ id: "email-otp", ...config })));

jest.mock("@/lib/project-access", () => ({
  normalizeAccessEmail: jest.fn((email: string) => email.trim().toLowerCase()),
  verifyAnyProjectAccess: jest.fn(),
}));

jest.mock("@/lib/auth-otp", () => ({
  consumeEmailOtp: jest.fn(),
}));

const mockVerifyAnyProjectAccess = verifyAnyProjectAccess as jest.MockedFunction<typeof verifyAnyProjectAccess>;
const mockConsumeEmailOtp = consumeEmailOtp as jest.MockedFunction<typeof consumeEmailOtp>;

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
      NEXTAUTH_SECRET: "test-secret",
    };
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("allows sign-in when the user can access any registered project", async () => {
    mockVerifyAnyProjectAccess.mockResolvedValue(true);

    const signIn = await loadSignInCallback();
    const result = await signIn({ user: { email: "Shared@Example.com" } });

    expect(result).toBe(true);
    expect(mockVerifyAnyProjectAccess).toHaveBeenCalledWith("shared@example.com");
  });

  it("rejects sign-in when the user cannot access any registered project", async () => {
    mockVerifyAnyProjectAccess.mockResolvedValue(false);

    const signIn = await loadSignInCallback();
    const result = await signIn({ user: { email: "outsider@example.com" } });

    expect(result).toBe(false);
    expect(mockVerifyAnyProjectAccess).toHaveBeenCalledWith("outsider@example.com");
  });

  it("rejects sign-in when the user email is missing", async () => {
    const signIn = await loadSignInCallback();
    const result = await signIn({ user: { email: null } });

    expect(result).toBe(false);
    expect(mockVerifyAnyProjectAccess).not.toHaveBeenCalled();
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

    const otpProvider = authOptions.providers.find((provider: { id: string }) => provider.id === "email-otp") as
      | { authorize: (credentials: { email: string; code: string }) => Promise<unknown> }
      | undefined;
    if (!otpProvider) {
      throw new Error("email-otp provider not found");
    }
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
