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
    - URL: `https://tu-dominio-publico/api/whatsapp/webhook`
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
