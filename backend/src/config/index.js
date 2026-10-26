function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`La variable ${name} debe ser numérica.`);
  return value;
}

function booleanFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const whatsappGatewayUrl = process.env.WHATSAPP_GATEWAY_URL || '';

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
    portalTokenTtlMinutes: numberFromEnv('OWNER_PORTAL_TOKEN_TTL_MINUTES', 15),
    localWebhookEnabled: booleanFromEnv('WHATSAPP_LOCAL_WEBHOOK_ENABLED', !whatsappGatewayUrl),
    gateway: {
      url: whatsappGatewayUrl,
      secret: process.env.FERRARO_GATEWAY_SECRET || '',
      pollIntervalMs: numberFromEnv('WHATSAPP_GATEWAY_POLL_INTERVAL_MS', 10000),
      batchSize: numberFromEnv('WHATSAPP_GATEWAY_BATCH_SIZE', 5)
    }
  }
});
