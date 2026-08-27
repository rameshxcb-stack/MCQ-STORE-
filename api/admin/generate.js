export default async function handler(req, res) {
  const dbUrl = process.env.TURSO_DATABASE_URL || "";
  const authToken = process.env.TURSO_AUTH_TOKEN || "";

  // Standardize HTTPS URL for raw HTTP check
  const httpUrl = dbUrl.replace("libsql://", "https://");

  try {
    // 1. Test URL Accessibility (Without Token)
    const urlCheck = await fetch(`${httpUrl}/version`).catch((err) => ({
      error: err.message,
    }));

    // 2. Test Authorization (With Token)
    const authCheck = await fetch(`${httpUrl}/v2/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: "SELECT 1" } }] }),
    });

    const authStatus = authCheck.status;
    const authResponseBody = await authCheck.text();

    // 3. Exact Diagnostic Verdict Logic
    let exactErrorCause = "UNKNOWN";

    if (urlCheck.error || (urlCheck.status && urlCheck.status === 404)) {
      exactErrorCause = "DB_URL_IS_WRONG (Database host name exist nahi karta ya invalid URL hai)";
    } else if (authStatus === 401) {
      exactErrorCause = "TOKEN_IS_WRONG (URL sahi hai par Token is specific DB ke sath match nahi ho raha ya invalid hai)";
    } else if (authStatus === 200) {
      exactErrorCause = "NONE (Everything is 100% Correct and Connected!)";
    } else {
      exactErrorCause = `OTHER_ISSUE (HTTP Status: ${authStatus})`;
    }

    return res.status(200).json({
      EXACT_DIAGNOSTIC_VERDICT: exactErrorCause,
      details: {
        urlStatus: urlCheck.status || urlCheck.error,
        tokenAuthHttpStatus: authStatus,
        tursoRawResponse: authResponseBody,
        testedUrl: dbUrl,
      },
    });
  } catch (err) {
    return res.status(500).json({
      EXACT_DIAGNOSTIC_VERDICT: "CRITICAL_SCRIPT_ERROR",
      error: err.message,
    });
  }
}
