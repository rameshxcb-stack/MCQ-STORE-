// api/test-turso-hardcoded.js
// ⚠️ TEMPORARY DIAGNOSTIC ENDPOINT – DELETE AFTER TESTING

import { createClient } from '@libsql/client';

// 🔥 Hardcoded credentials (same as your working connection)
const TURSO_URL = 'libsql://mcq-rameshxcb-stack.aws-ap-south-1.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODc5NzU1ODAsImlkIjoiMDFhMDA5NTgtMWQwMS03YzQ4LWI2ZDktMmI4OGQwMDgyNTY1Iiwia2lkIjoiQ185cDN0WVAzRW1yb2xaa2hvUGlMWDNaeHVxSWxROUU4dGJLQXp5a1lEdyIsInJpZCI6ImY0M2VhNzc1LTNkMjYtNDZhMi05NmY4LThlNzRiM2NlNDJlZiJ9.8cGh7_MyO9SePYKJvjm0wrz56yGRwfuXHeOoslaAO9o-TbkSfoO456tYCL1Bz2MBqQM4jLRkG-wJJPvc3yk9BA';

export default async function handler(req, res) {
  // Allow GET (or POST) for easy testing
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      status: 'ERROR',
      message: 'Only GET or POST allowed.'
    });
  }

  try {
    const db = createClient({
      url: TURSO_URL,
      authToken: TURSO_TOKEN
    });

    const result = await db.execute('SELECT 1 AS is_active');

    return res.status(200).json({
      status: 'SUCCESS',
      message: 'Hard-coded Turso credentials accepted.',
      test: 'SELECT 1',
      connected: true,
      rows: result.rows || []
    });

  } catch (error) {
    return res.status(401).json({
      status: 'ERROR',
      message: 'Hard-coded Turso credentials were rejected.',
      connected: false,
      errorName: error?.name || 'UnknownError',
      errorCode: error?.code || null,
      errorMessage: String(error?.message || error)
        .replace(/\s+/g, ' ')
        .slice(0, 500)
    });
  }
}
