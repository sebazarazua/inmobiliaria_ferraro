# Seguridad de acceso

## Modo de ejecución vigente

El sistema es **local y de un solo operador**: no tiene cuentas de usuario ni sesiones. La auditoría registra `local-operator`. Esto es aceptable solamente si el servidor escucha en la computadora local.

## Barreras implementadas (`backend/src/lib/access.js`)

| Riesgo | Barrera |
|---|---|
| Exposición a la red sin autenticación | El servidor no arranca con `HOST` distinto de loopback (`127.0.0.1`, `localhost`, `::1`) salvo `FERRARO_ALLOW_UNAUTHENTICATED_NETWORK=true` (desaconsejado). |
| DNS rebinding (un dominio hostil que resuelve a 127.0.0.1) | Solo se atienden pedidos con `Host` loopback, el host de `PUBLIC_BASE_URL` o `FERRARO_ALLOWED_HOSTS`. Lo demás recibe `421`. |
| CSRF desde otra página abierta en el navegador | Las escrituras (`POST`, `PATCH`, `PUT`, `DELETE`) se rechazan si `Origin` no coincide con el host, si `Sec-Fetch-Site` no es `same-origin`/`none`, o si el cuerpo no es JSON o multipart. Un formulario HTML de otro sitio recibe `403` o `415`. |
| Clickjacking | `X-Frame-Options: DENY` y `frame-ancestors 'none'`. |

Excepción: `/api/whatsapp/webhook` (llamada servidor a servidor, verificada por firma HMAC). Está desactivada por defecto cuando se usa el gateway.

Verificado por `tests/stabilization.test.js` (E11) y por las pruebas de navegador existentes, que siguen operando con `Origin` real.

## Lo que estas barreras NO resuelven

- Cualquier proceso o persona con acceso a la computadora puede operar la cartera.
- No hay identificación del actor en las operaciones financieras.
- Un túnel (por ejemplo `cloudflared`, presente en `.tools/`) que publique el puerto queda bloqueado por la verificación de `Host`. **No agregar el dominio del túnel a `FERRARO_ALLOWED_HOSTS` mientras no exista autenticación.**

## Diseño para habilitar acceso remoto (pendiente de decisión)

Requisito previo: decidir quién accede (¿solo administración?, ¿propietarios?) y desde dónde (red privada o Internet).

Propuesta mínima, sin proveedores externos:

1. Tabla `operators(id, name, role, password_hash scrypt, disabled_at)` y `sessions(id_hash, operator_id, expires_at, revoked_at)`. Roles: `lectura`, `administracion`, `finanzas`.
2. `POST /api/session` con limitación de intentos; cookie `__Host-ferraro_session` (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`).
3. Middleware: todo `/api/*` exige sesión salvo el webhook firmado. Las escrituras financieras (pagos, servicios, gastos, punitorios, rectificaciones, borrados) exigen rol `finanzas`.
4. Reemplazar `actor:{id:'local-operator'}` por el operador de la sesión en `services`, `late-fees`, `contracts/rectification` y `audit_log`.
5. Exposición solo por HTTPS (proxy inverso o túnel con TLS). El primer operador se crea con un comando local, sin contraseñas por defecto.
6. Pruebas: acceso anónimo rechazado, rol insuficiente rechazado, sesión expirada o revocada, fijación de sesión, CSRF con cookie y actor registrado en cada operación.

Hasta que esto exista y esté probado, el sistema **no es apto para red ni para Internet**.
