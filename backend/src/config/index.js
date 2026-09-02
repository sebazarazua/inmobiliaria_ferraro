function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`La variable ${name} debe ser numérica.`);
  return value;
}

module.exports = Object.freeze({
  host: process.env.HOST || '127.0.0.1',
  port: numberFromEnv('PORT', 4173),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://ferraro:ferraro_local@127.0.0.1:54329/inmobiliaria',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://${process.env.HOST || '127.0.0.1'}:${numberFromEnv('PORT', 4173)}`,
  whatsapp: {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'ferraro-whatsapp-verify-token',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION || 'v20.0',
    sessionTtlHours: numberFromEnv('WHATSAPP_SESSION_TTL_HOURS', 720),
    pendingAuthTtlMinutes: numberFromEnv('WHATSAPP_PENDING_AUTH_TTL_MINUTES', 30),
    maxAuthAttempts: numberFromEnv('WHATSAPP_MAX_AUTH_ATTEMPTS', 3),
    portalTokenTtlMinutes: numberFromEnv('OWNER_PORTAL_TOKEN_TTL_MINUTES', 15)
  }
});
