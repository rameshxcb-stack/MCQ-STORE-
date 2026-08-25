export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const rawUrl = process.env.TURSO_DATABASE_URL || '';
  const rawToken = process.env.TURSO_AUTH_TOKEN || '';

  const cleanUrl = rawUrl.trim().replace(/^["']|["']$/g, '');
  const cleanToken = rawToken.trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '');

  let decodedTokenData = null;
  let tokenParsingError = null;
  let tokenExpiryStatus = "UNKNOWN";

  // 🔍 1. JWT TOKEN DECODER
  try {
    const parts = cleanToken.split('.');
    if (parts.length === 3) {
      const payloadBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const decodedPayload = Buffer.from(payloadBase64, 'base64').toString('utf8');
      decodedTokenData = JSON.parse(decodedPayload);

      // Expiry Check
      if (decodedTokenData.exp) {
        const expTimeMs = decodedTokenData.exp * 1000;
        const currentTimeMs = Date.now();
        const dateObj = new Date(expTimeMs);

        if (currentTimeMs > expTimeMs) {
          tokenExpiryStatus = `EXPIRED on ${dateObj.toUTCString()}`;
        } else {
          tokenExpiryStatus = `VALID (Expires on ${dateObj.toUTCString()})`;
        }
      } else {
        tokenExpiryStatus = "NO_EXPIRY_LIMIT (Never Expires)";
      }
    } else {
      tokenParsingError = "INVALID_JWT_STRUCTURE: Token me 3 parts (.) nahi hain. Copy-paste adhoora hua hai.";
    }
  } catch (err) {
    tokenParsingError = `DECODE_FAILED: ${err.message}. Token text corrupt ya broken hai.`;
  }

  // 🔍 2. EXACT DIAGNOSIS CONCLUSION
  let exactReason = "";
  if (tokenParsingError) {
    exactReason = "REASON 1: GALAT COPY HUA HAI (Token text is broken or corrupted).";
  } else if (tokenExpiryStatus.startsWith("EXPIRED")) {
    exactReason = "REASON 2: EXPIRE HO GAYA HAI (Token's expiration date has passed).";
  } else {
    exactReason = "REASON 3: GALAT DATABASE KA TOKEN HAI YA REVOKED HAI (Token format/time valid hai, par Turso is DB se authorize nahi kar raha).";
  }

  return res.status(200).json({
    EXACT_VERDICT: exactReason,
    tokenDetails: {
      expiryCheck: tokenExpiryStatus,
      targetDatabaseId: decodedTokenData?.pdb || decodedTokenData?.db || "Not Found in payload",
      tokenIssuer: decodedTokenData?.iss || "Unknown",
      tokenType: decodedTokenData?.a ? "Full Access / Admin" : "Read-only / Custom",
      rawDecodedPayload: decodedTokenData || null,
      parsingError: tokenParsingError
    },
    usedUrl: cleanUrl
  });
}
