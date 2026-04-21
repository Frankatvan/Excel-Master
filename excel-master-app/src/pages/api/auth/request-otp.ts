import type { NextApiRequest, NextApiResponse } from "next";

import { requestEmailOtp } from "@/lib/auth-otp";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const email = typeof req.body?.email === "string" ? req.body.email : "";
  if (!email.trim()) {
    return res.status(400).json({ error: "Email is required." });
  }

  try {
    const payload = await requestEmailOtp(email);
    return res.status(200).json({
      status: "sent",
      email: payload.email,
      expires_at: payload.expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send verification code.";
    const statusCode =
      message === "Email is not authorized for this workbook."
        ? 403
        : message === "Please wait before requesting another verification code."
          ? 429
          : 500;

    return res.status(statusCode).json({ error: message });
  }
}
