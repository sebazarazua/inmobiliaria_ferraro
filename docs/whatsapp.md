# Módulo WhatsApp Business

## Arquitectura

El módulo usa exclusivamente WhatsApp Business Platform / Cloud API de Meta.

Capas:

- `backend/src/modules/whatsapp/index.js`: normalización, proveedor Meta, webhooks, bot determinístico, sesiones, tokens de portal, automatizaciones y cola de salida.
- `database/migrations/011_whatsapp_business.sql`: conversaciones, mensajes, eventos de webhook, tokens temporales, templates, automatizaciones y jobs.
- `frontend/src/pages/WhatsAppPage.jsx`: panel administrativo.
- `OwnerModal`: preferencias WhatsApp por propietario.

No se usa WhatsApp Web, Selenium, Baileys, whatsapp-web.js ni Twilio.

## Variables de entorno

Configurar en el entorno del backend:

```env
PUBLIC_BASE_URL=https://tu-dominio-publico
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_GRAPH_VERSION=v20.0
WHATSAPP_SESSION_TTL_HOURS=720
WHATSAPP_PENDING_AUTH_TTL_MINUTES=30
WHATSAPP_MAX_AUTH_ATTEMPTS=3
OWNER_PORTAL_TOKEN_TTL_MINUTES=15
```

Nunca cargar tokens en el frontend.

## Webhooks

Endpoint:

```text
GET  /api/whatsapp/webhook
POST /api/whatsapp/webhook
```

El GET valida:

- `hub.mode=subscribe`
- `hub.verify_token`
- responde `hub.challenge`

El POST valida `X-Hub-Signature-256` con HMAC-SHA256 usando `WHATSAPP_APP_SECRET`.

Eventos soportados:

- mensajes entrantes;
- estados `sent`, `delivered`, `read`, `failed`;
- idempotencia por message ID/status ID.

## Flujo de autenticación del propietario

1. Normaliza el teléfono a E.164.
2. Busca propietarios con WhatsApp cargado.
3. Si encuentra propietario, pide DNI/CUIT.
4. Valida teléfono + DNI/CUIT.
5. Crea sesión verificada temporal.
6. Nunca revela información privada antes de validar identidad.
7. Bloquea la conversación al superar intentos configurados.

Comandos:

- `hola`, `menu`, `menú`, `ayuda`
- `liquidacion`, `liquidación`
- `pagos`
- `propiedades`
- `portal`
- `documentos`
- `asesor`, `humano`
- `BAJA`, `STOP`, `NO QUIERO RECIBIR`, `CANCELAR NOTIFICACIONES`
- `ALTA`, `REACTIVAR`

## Portal del propietario

Al pedir portal se genera un token aleatorio, firmado por hash SHA-256 en base de datos, con vencimiento configurable.

Endpoint de verificación:

```text
GET /api/owner-portal/verify?token=...
```

No se envían IDs internos por WhatsApp.

## Templates

Templates internos contemplados:

- `propietario_nueva_liquidacion`
- `propietario_transferencia_realizada`
- `propietario_ajuste_proximo`
- `propietario_contrato_por_vencer`
- `propietario_documento_disponible`
- `propietario_actualizacion`

En el panel se puede habilitar/deshabilitar el mapeo y ver estado. Los nombres deben existir y estar aprobados en Meta para mensajes iniciados por la inmobiliaria fuera de la ventana de conversación.

## Automatizaciones

Eventos iniciales:

- `NEW_LIQUIDATION`
- `TRANSFER_DONE`
- `UPCOMING_ADJUSTMENT`
- `CONTRACT_EXPIRING`
- `DOCUMENT_AVAILABLE`
- `PAYMENT_REGISTERED`

`PAYMENT_REGISTERED` ya se dispara desde el registro de cobros. Las demás automatizaciones están modeladas y listas para conectarse a los eventos de negocio correspondientes cuando se creen esas acciones oficiales.

Cada automatización usa `idempotency_key` para evitar duplicados.

Procesamiento manual de cola:

```text
POST /api/whatsapp/jobs/process
```

## Panel administrativo

Ruta:

```text
#whatsapp
```

Secciones:

- Dashboard
- Conversaciones
- Templates
- Automatizaciones
- Configuración

Funciones:

- ver conversaciones;
- ver historial;
- responder manualmente;
- tomar conversación;
- cerrar conversación;
- devolver al bot;
- procesar cola;
- activar/desactivar templates y automatizaciones.

## Seguridad

Implementado:

- validación de firma del webhook;
- token temporal para portal;
- idempotencia;
- no exposición de tokens en frontend;
- opt-out;
- límite de intentos de autenticación;
- sesiones con vencimiento;
- handoff humano;
- datos del propietario sólo después de autenticar.

Pendiente si el sistema pasa a producción multiusuario:

- autenticación real del panel administrativo;
- roles/permisos por usuario interno;
- dominio HTTPS público y estable;
- política formal de retención de mensajes.

## Testing

Ejecutar:

```bash
pnpm test
pnpm check
```

La API externa de Meta se mockea por ausencia de credenciales reales; la lógica interna, persistencia y webhooks se prueban contra PostgreSQL.

## Configuración exacta en Meta

1. Entrar a [Meta for Developers](https://developers.facebook.com/).
2. Crear o usar una cuenta Business Manager de Eugenio A. Ferraro Propiedades.
3. Crear una App tipo Business.
4. Agregar producto “WhatsApp”.
5. En WhatsApp > Getting Started, crear/asociar WhatsApp Business Account.
6. Asociar un número telefónico de la inmobiliaria.
7. Copiar:
   - Phone Number ID → `WHATSAPP_PHONE_NUMBER_ID`
   - WhatsApp Business Account ID → `WHATSAPP_BUSINESS_ACCOUNT_ID`
8. Generar un access token permanente o de sistema con permisos de WhatsApp.
9. Guardar ese token como `WHATSAPP_ACCESS_TOKEN`.
10. Copiar el App Secret de la app y guardarlo como `WHATSAPP_APP_SECRET`.
11. Definir un verify token propio y guardarlo como `WHATSAPP_VERIFY_TOKEN`.
12. Configurar webhook:
    - URL: `https://ferraro-whatsapp.vercel.app/api/whatsapp/webhook`
    - Verify token: el mismo valor de `WHATSAPP_VERIFY_TOKEN`
13. Suscribirse al campo/evento `messages`.
14. Crear en WhatsApp Manager los templates listados arriba.
15. Esperar aprobación de Meta para templates de utilidad.
16. Probar con un número de testing.
17. Pasar a producción verificando Business Manager, número, dominio HTTPS y límites de mensajería.

## Troubleshooting

- `401 Firma de webhook inválida`: revisar `WHATSAPP_APP_SECRET`.
- Webhook no verifica: revisar `WHATSAPP_VERIFY_TOKEN` y URL pública HTTPS.
- Mensajes salientes fallan: revisar `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` y permisos.
- El propietario no autentica: revisar WhatsApp cargado y DNI/CUIT en la ficha.
- No recibe notificaciones: revisar opt-in y preferencias del propietario.

## Gateway Vercel

Arquitectura objetivo:

```text
WhatsApp -> Meta -> Vercel -> worker local Ferraro -> PostgreSQL local -> Meta -> WhatsApp
```

Endpoint publico fijo para configurar en Meta:

```text
https://ferraro-whatsapp.vercel.app/api/whatsapp/webhook
```

El gateway vive en `gateway/`. No accede a PostgreSQL y no necesita `WHATSAPP_ACCESS_TOKEN`: el token de envio de Meta permanece en el backend local. El gateway recibe `GET` de verificacion, recibe `POST` de eventos, valida `X-Hub-Signature-256` con `WHATSAPP_APP_SECRET` y guarda temporalmente eventos minimizados en una cola cloud.

Persistencia elegida: Upstash Redis por REST. Se eligio porque Vercel no tiene filesystem persistente para funciones serverless, Upstash funciona por HTTPS desde Vercel y desde la PC local, tiene plan gratis inicial y permite implementar cola con idempotencia, leases y reintentos sin mover la base local.

Variables del gateway en Vercel:

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

Variables nuevas del backend local:

```env
WHATSAPP_GATEWAY_URL=https://ferraro-whatsapp.vercel.app
FERRARO_GATEWAY_SECRET=
WHATSAPP_GATEWAY_POLL_INTERVAL_MS=10000
WHATSAPP_GATEWAY_BATCH_SIZE=5
WHATSAPP_LOCAL_WEBHOOK_ENABLED=false
```

El worker local se inicia automaticamente en `backend/src/server.js` junto con el backend Ferraro cuando `WHATSAPP_GATEWAY_URL` y `FERRARO_GATEWAY_SECRET` estan configurados. El intervalo por defecto es 10000 ms. En cada ciclo reclama hasta 5 eventos, llama a `processWebhookPayload(db,payload)`, consulta PostgreSQL local, genera la respuesta, envia a Meta desde la PC local y confirma `ack` al gateway.

Cuando `WHATSAPP_GATEWAY_URL` esta configurado, el webhook local `/api/whatsapp/webhook` queda desactivado por defecto para no mantener dos caminos productivos. Solo puede reactivarse explicitamente con `WHATSAPP_LOCAL_WEBHOOK_ENABLED=true` para pruebas controladas.

Informacion que atraviesa Vercel/Upstash: ID del evento, WhatsApp message/status ID, telefono remitente o destinatario, tipo de mensaje, texto recibido o seleccion interactiva, timestamp, estado de procesamiento, intentos y lease tecnico. No atraviesan Vercel contratos, PDFs, liquidaciones completas, propietarios replicados, inquilinos, propiedades ni credenciales de envio a Meta.

Si la PC esta apagada, los eventos quedan en `ferraro:whatsapp:pending` dentro de Upstash Redis hasta que vuelva el backend local o hasta la retencion configurada. Al procesarse correctamente, el gateway borra el payload.

Endpoints privados del gateway, siempre con `Authorization: Bearer <FERRARO_GATEWAY_SECRET>`:

```text
POST /api/whatsapp/events/claim
POST /api/whatsapp/events/ack
POST /api/whatsapp/events/nack
GET  /api/whatsapp/events/status
```

Prueba end-to-end:

1. Crear una base Upstash Redis y copiar `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN`.
2. Desplegar `gateway/` en Vercel con el proyecto `ferraro-whatsapp`.
3. Configurar en Meta la URL `https://ferraro-whatsapp.vercel.app/api/whatsapp/webhook` y el mismo `WHATSAPP_VERIFY_TOKEN`.
4. Configurar en `.env` local `WHATSAPP_GATEWAY_URL`, `FERRARO_GATEWAY_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` y `WHATSAPP_BUSINESS_ACCOUNT_ID`.
5. Iniciar Ferraro con `pnpm start` o `pnpm dev:api`.
6. Enviar un WhatsApp de prueba desde un numero cargado en propietarios.
7. Verificar el estado de cola:

```bash
curl -H "Authorization: Bearer $FERRARO_GATEWAY_SECRET" https://ferraro-whatsapp.vercel.app/api/whatsapp/events/status
```

8. Confirmar en el panel `#whatsapp` que se registro la conversacion y que la respuesta salio por Meta.
