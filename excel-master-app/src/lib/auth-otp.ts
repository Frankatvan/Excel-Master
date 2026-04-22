import crypto from "node:crypto";

import nodemailer from "nodemailer";

import { normalizeEmail, verifySheetAccess } from "@/lib/auth-access";
import { getSupabaseClient } from "@/lib/auth-supabase";

interface EmailOtpRecord {
  email: string;
  code_hash: string;
  attempt_count: number;
  requested_at: string;
  expires_at: string;
  consumed_at: string | null;
}

function getOtpNumberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hashOtpCode(code: string) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function createOtpCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function buildMailTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number.parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("SMTP environment variables are missing.");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass,
    },
  });
}

export async function requestEmailOtp(emailInput: string) {
  const email = normalizeEmail(emailInput);
  if (!email) {
    throw new Error("Email is required.");
  }

  const isAuthorized = await verifySheetAccess(email);
  if (!isAuthorized) {
    throw new Error("Email is not authorized for this workbook.");
  }

  const supabase = getSupabaseClient();
  const { data: existingRecord, error: selectError } = await supabase
    .from("email_login_otps")
    .select("*")
    .eq("email", email)
    .maybeSingle();

  if (selectError) {
    throw selectError;
  }

  const now = new Date();
  const resendCooldownSeconds = getOtpNumberEnv("EMAIL_OTP_RESEND_COOLDOWN_SECONDS", 60);

  if (existingRecord?.requested_at) {
    const lastRequestedAt = new Date(existingRecord.requested_at);
    if (lastRequestedAt.getTime() + resendCooldownSeconds * 1000 > now.getTime()) {
      throw new Error("Please wait before requesting another verification code.");
    }
  }

  const code = createOtpCode();
  const ttlMinutes = getOtpNumberEnv("EMAIL_OTP_TTL_MINUTES", 10);
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();

  const { error: upsertError } = await supabase.from("email_login_otps").upsert(
    {
      email,
      code_hash: hashOtpCode(code),
      attempt_count: 0,
      requested_at: now.toISOString(),
      expires_at: expiresAt,
      consumed_at: null,
    },
    { onConflict: "email" },
  );

  if (upsertError) {
    throw upsertError;
  }

  const transport = buildMailTransport();
  const from = process.env.EMAIL_OTP_FROM || process.env.SMTP_USER!;

  await transport.sendMail({
    to: email,
    from,
    subject: `Your AiWB verification code: ${code}`,
    text: `Your AiWB verification code is ${code}. It expires in ${ttlMinutes} minutes.`,
  });

  return {
    email,
    expiresAt,
  };
}

export async function consumeEmailOtp(emailInput: string, codeInput: string) {
  const email = normalizeEmail(emailInput);
  const code = codeInput.trim();

  if (!email || !code) {
    return null;
  }

  const isAuthorized = await verifySheetAccess(email);
  if (!isAuthorized) {
    return null;
  }

  const supabase = getSupabaseClient();
  const { data: otpRecord, error: selectError } = await supabase
    .from("email_login_otps")
    .select("*")
    .eq("email", email)
    .maybeSingle();

  if (selectError || !otpRecord) {
    return null;
  }

  const record = otpRecord as EmailOtpRecord;
  const maxAttempts = getOtpNumberEnv("EMAIL_OTP_MAX_ATTEMPTS", 5);

  if (record.consumed_at) {
    return null;
  }

  if (new Date(record.expires_at).getTime() <= Date.now()) {
    return null;
  }

  if (record.attempt_count >= maxAttempts) {
    return null;
  }

  if (hashOtpCode(code) !== record.code_hash) {
    await supabase
      .from("email_login_otps")
      .update({ attempt_count: record.attempt_count + 1 })
      .eq("email", email);
    return null;
  }

  await supabase
    .from("email_login_otps")
    .update({ consumed_at: new Date().toISOString() })
    .eq("email", email);

  return {
    id: email,
    email,
    name: email,
  };
}
