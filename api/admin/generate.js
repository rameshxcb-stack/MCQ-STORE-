// ============================================================
// 🚀 ACTION 1: QUERY EXECUTOR (SDK Version - Zero Token Issue)
// ============================================================
if (action === 'query' || queryType) {
  const finalQueryType = queryType || 'check_connection';
  const queryConfig = QUERY_REGISTRY[finalQueryType];

  if (!queryConfig) {
    return res.status(403).json({
      status: 'ERROR',
      error: 'INVALID_QUERY',
      message: `Query type "${finalQueryType}" is not allowed.`
    });
  }

  try {
    const db = getDb(); // Same SDK jo Dashboard/Task Processor use kar raha hai
    const result = await db.execute({
      sql: queryConfig.sql,
      args: args
    });

    return res.status(200).json({
      status: 'SUCCESS',
      message: '✅ Query executed successfully!',
      data: result
    });
  } catch (err) {
    return res.status(500).json({
      status: 'ERROR',
      error: 'TURSO_ERROR',
      message: err.message
    });
  }
}
