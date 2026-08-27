import { createClient } from "@libsql/client";

// Turso Client Initialization (Strictly using Vercel Environment Variables)
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export default async function handler(req, res) {
  try {
    // 1. Check if environment variables are loaded properly
    if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
      return res.status(500).json({
        success: false,
        error: "Environment Variables (TURSO_DATABASE_URL or TURSO_AUTH_TOKEN) are missing in Vercel.",
      });
    }

    // 2. Perform a test query to verify database connection
    const result = await db.execute("SELECT 1 AS status;");

    // 3. Success Response
    return res.status(200).json({
      success: true,
      message: "Turso Database Connected Successfully!",
      data: result.rows,
    });
  } catch (error) {
    // 4. Catch and return any database query errors
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
