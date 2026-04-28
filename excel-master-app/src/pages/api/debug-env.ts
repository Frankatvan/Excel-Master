
import type { NextApiRequest, NextApiResponse } from 'next'

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const maskedClientId = clientId ? clientId.substring(0, 10) + "..." + clientId.substring(clientId.length - 5) : "MISSING";
  const deploymentCommit = process.env.VERCEL_GIT_COMMIT_SHA
    ? process.env.VERCEL_GIT_COMMIT_SHA.substring(0, 8)
    : "MISSING";
  
  res.status(200).json({ 
    clientId: maskedClientId,
    hasSecret: !!process.env.GOOGLE_CLIENT_SECRET,
    nextAuthUrl: process.env.NEXTAUTH_URL,
    hasServiceAccountJson: !!process.env.GOOGLE_CREDENTIALS_JSON,
    hasGoogleProjectId: !!process.env.GOOGLE_PROJECT_ID,
    hasGooglePrivateKey: !!process.env.GOOGLE_PRIVATE_KEY,
    hasGoogleClientEmail: !!process.env.GOOGLE_CLIENT_EMAIL,
    hasWorkerUrlOverride: !!process.env.RECLASSIFY_WORKER_URL,
    hasExternalImportWorkerUrl: !!process.env.EXTERNAL_IMPORT_WORKER_URL,
    hasExternalImportWorkerSecret: !!process.env.EXTERNAL_IMPORT_WORKER_SECRET,
    hasVercelAutomationBypassSecret: !!process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    deploymentCommit,
    vercelEnv: process.env.VERCEL_ENV || "unknown",
  })
}
