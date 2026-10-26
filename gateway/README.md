# Ferraro WhatsApp Gateway

Gateway minimo para desplegar en Vercel y recibir webhooks oficiales de WhatsApp Cloud API.

URL esperada:

```text
https://ferraro-whatsapp.vercel.app/api/whatsapp/webhook
```

## Persistencia

Usa Upstash Redis por REST. Es compatible con Vercel serverless porque funciona por HTTPS, no requiere conexiones TCP persistentes y tiene plan inicial gratis. Los eventos se guardan minimizados, de a un mensaje/estado, en:

- `ferraro:whatsapp:pending`: eventos pendientes.
- `ferraro:whatsapp:processing`: eventos reclamados con lease temporal.
- `ferraro:whatsapp:dead`: eventos que agotaron reintentos.
- `ferraro:whatsapp:event:<id>`: payload temporal.

El payload temporal contiene solo datos de transporte de WhatsApp: ID, remitente, tipo, texto o reply interactivo, timestamp y estado tecnico. No contiene contratos, PDFs, liquidaciones, propietarios replicados ni datos internos de Ferraro. Se borra al recibir `ack` del backend local. Si la PC local esta apagada, queda en `pending` hasta que el worker vuelva a consultar. La retencion por defecto es 7 dias (`QUEUE_RETENTION_SECONDS=604800`).

## Variables

```env
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=ferraro-whatsapp-verify-token
FERRARO_GATEWAY_SECRET=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
QUEUE_PREFIX=ferraro:whatsapp
QUEUE_RETENTION_SECONDS=604800
QUEUE_LEASE_SECONDS=120
QUEUE_MAX_ATTEMPTS=8
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX=120
```

`FERRARO_GATEWAY_SECRET` debe ser largo y aleatorio. No debe exponerse en frontend.

## Endpoints

Publico para Meta:

```text
GET  /api/whatsapp/webhook
POST /api/whatsapp/webhook
```

Privados para el backend local, con `Authorization: Bearer <FERRARO_GATEWAY_SECRET>`:

```text
POST /api/whatsapp/events/claim
POST /api/whatsapp/events/ack
POST /api/whatsapp/events/nack
GET  /api/whatsapp/events/status
```

## Deploy

Desde esta carpeta:

```bash
vercel --name ferraro-whatsapp
vercel env add WHATSAPP_APP_SECRET production
vercel env add WHATSAPP_VERIFY_TOKEN production
vercel env add FERRARO_GATEWAY_SECRET production
vercel env add UPSTASH_REDIS_REST_URL production
vercel env add UPSTASH_REDIS_REST_TOKEN production
vercel --prod
```
