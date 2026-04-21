
import NextAuth from "next-auth";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";

jest.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn(() => ({})),
    },
    drive: jest.fn(() => ({
      permissions: {
        list: jest.fn(),
      },
    })),
  },
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      upsert: jest.fn(),
    })),
  })),
}));

const mockDrive = google.drive as jest.Mock;
const mockSupabase = createClient as jest.Mock;

describe("NextAuth signIn callback", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = process.env;
    process.env = {
      ...originalEnv,
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      GOOGLE_SHEET_ID: "test-sheet-id",
      SUPABASE_URL: "http://test-supabase-url",
      SUPABASE_ANON_KEY: "test-supabase-key",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  it("should return true and upsert user when user has access", async () => {
    const listMock = jest.fn().mockResolvedValue({
        data: {
          permissions: [{ emailAddress: "test@example.com" }],
        },
      });
    const upsertMock = jest.fn().mockResolvedValue({ data: { some: 'data' }, error: null });

    (mockDrive as any).mockReturnValue({
        permissions: {
            list: listMock,
        },
    });
    (mockSupabase as any).mockReturnValue({
        from: () => ({
            upsert: upsertMock,
        }),
    });

    const { authOptions } = require("../[...nextauth]");
    const signIn = authOptions.callbacks.signIn;

    const result = await signIn({
      user: { id: "123", email: "test@example.com" },
      account: {},
      profile: {},
    });

    expect(result).toBe(true);
    expect(listMock).toHaveBeenCalledWith({
      fileId: "test-sheet-id",
      fields: "permissions(emailAddress)",
    });
    expect(upsertMock).toHaveBeenCalledWith(
      { sub: "123", email: "test@example.com" },
      { onConflict: 'sub' }
    );
  });

  it("should return false when user does not have access", async () => {
    const listMock = jest.fn().mockResolvedValue({
        data: {
          permissions: [{ emailAddress: "another@example.com" }],
        },
      });
    const upsertMock = jest.fn();

    (mockDrive as any).mockReturnValue({
        permissions: {
            list: listMock,
        },
    });
    (mockSupabase as any).mockReturnValue({
        from: () => ({
            upsert: upsertMock,
        }),
    });

    const { authOptions } = require("../[...nextauth]");
    const signIn = authOptions.callbacks.signIn;

    const result = await signIn({
      user: { id: "123", email: "test@example.com" },
      account: {},
      profile: {},
    });

    expect(result).toBe(false);
    expect(listMock).toHaveBeenCalledWith({
      fileId: "test-sheet-id",
      fields: "permissions(emailAddress)",
    });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("should return false when there is an error verifying sheet access", async () => {
    const listMock = jest.fn().mockRejectedValue(new Error("API Error"));
    const upsertMock = jest.fn();

    (mockDrive as any).mockReturnValue({
        permissions: {
            list: listMock,
        },
    });
    (mockSupabase as any).mockReturnValue({
        from: () => ({
            upsert: upsertMock,
        }),
    });

    const { authOptions } = require("../[...nextauth]");
    const signIn = authOptions.callbacks.signIn;

    const result = await signIn({
      user: { id: "123", email: "test@example.com" },
      account: {},
      profile: {},
    });

    expect(result).toBe(false);
    expect(listMock).toHaveBeenCalledWith({
      fileId: "test-sheet-id",
      fields: "permissions(emailAddress)",
    });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("should return false when there is an error upserting to supabase", async () => {
    const listMock = jest.fn().mockResolvedValue({
        data: {
          permissions: [{ emailAddress: "test@example.com" }],
        },
      });
    const upsertMock = jest.fn().mockResolvedValue({ data: null, error: new Error("Supabase Error") });

    (mockDrive as any).mockReturnValue({
        permissions: {
            list: listMock,
        },
    });
    (mockSupabase as any).mockReturnValue({
        from: () => ({
            upsert: upsertMock,
        }),
    });

    const { authOptions } = require("../[...nextauth]");
    const signIn = authOptions.callbacks.signIn;

    const result = await signIn({
      user: { id: "123", email: "test@example.com" },
      account: {},
      profile: {},
    });

    expect(result).toBe(false);
    expect(listMock).toHaveBeenCalledWith({
      fileId: "test-sheet-id",
      fields: "permissions(emailAddress)",
    });
    expect(upsertMock).toHaveBeenCalledWith(
        { sub: "123", email: "test@example.com" },
        { onConflict: 'sub' }
      );
  });
});
