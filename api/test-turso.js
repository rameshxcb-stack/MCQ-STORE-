// api/test-turso.js

import { diagnoseTursoCredentials } from '../lib/turso-diagnostics.js';

function safeError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

export default async function handler(req, res) {
  const requestId =
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-admin-key, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      status: 'ERROR',
      error: 'METHOD_NOT_ALLOWED',
      message: 'Only POST is allowed.',
      requestId
    });
  }

  try {
    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body || {});

    // Optional protection.
    // If ADMIN_API_KEY exists in Vercel, require it.
    const configuredAdminKey = process.env.ADMIN_API_KEY;

    if (configuredAdminKey) {
      const suppliedAdminKey =
        req.headers['x-admin-key'] ||
        req.headers.authorization?.replace(/^Bearer\s+/i, '');

      if (
        !suppliedAdminKey ||
        suppliedAdminKey !== configuredAdminKey
      ) {
        return res.status(403).json({
          status: 'ERROR',
          error: 'UNAUTHORIZED',
          message: 'Valid x-admin-key required.',
          requestId
        });
      }
    }

    if (body.action !== 'check') {
      return res.status(400).json({
        status: 'ERROR',
        error: 'INVALID_ACTION',
        message: 'Use action: "check".',
        requestId
      });
    }

    const url = body.url;
    const token = body.token;

    if (typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({
        status: 'ERROR',
        error: 'MISSING_URL',
        message: 'A Turso libsql:// URL is required.',
        requestId
      });
    }

    if (typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({
        status: 'ERROR',
        error: 'MISSING_TOKEN',
        message: 'A Turso auth token is required.',
        requestId
      });
    }

    const diagnostics = await diagnoseTursoCredentials({
      url,
      token
    });

    const status =
      diagnostics.compatibility.status === 'CONFIRMED'
        ? 200
        : diagnostics.compatibility.status === 'REJECTED'
          ? 401
          : diagnostics.compatibility.status === 'FORBIDDEN'
            ? 403
            : 200;

    return res.status(status).json({
      status:
        diagnostics.compatibility.status === 'CONFIRMED'
          ? 'SUCCESS'
          : 'ERROR',

      message:
        diagnostics.compatibility.reason,

      diagnostics,

      requestId
    });

  } catch (error) {
    return res.status(500).json({
      status: 'ERROR',
      error: 'TURSO_DIAGNOSTIC_ERROR',
      message: safeError(error),
      requestId
    });
  }
}
