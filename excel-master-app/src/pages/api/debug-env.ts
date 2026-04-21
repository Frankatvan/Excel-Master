
import type { NextApiRequest, NextApiResponse } from 'next'

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const maskedClientId = clientId ? clientId.substring(0, 10) + "..." + clientId.substring(clientId.length - 5) : "MISSING";
  
  res.status(200).json({ 
    clientId: maskedClientId,
    hasSecret: !!process.env.GOOGLE_CLIENT_SECRET,
    nextAuthUrl: process.env.NEXTAUTH_URL
  })
}
