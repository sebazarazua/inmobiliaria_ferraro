# Arquitectura

## Capas

```text
React + Vite (frontend/)
        |
        | HTTP /api
        v
Aplicación (backend/src/app.js)
        |
        +-- PostgreSQL 17 (backend/src/database/)
        +-- Importación PDF (backend/src/modules/imports/)
        +-- Archivos observados (contratos/)
```

El frontend es una SPA en React construida con Vite. En desarrollo usa el proxy de Vite y en producción el backend sirve `frontend/dist`. El backend expone JSON y PostgreSQL es la fuente de verdad; los PDF originales permanecen en `contratos/` y se identifican por SHA-256.

## Responsabilidades

- `backend/src/server.js`: proceso, puerto, escáner periódico y cierre ordenado.
- `backend/src/app.js`: composición de API, casos de uso actuales y archivos estáticos.
- `backend/src/config/`: configuración del proceso y rutas del proyecto.
- `backend/src/database/`: pool de PostgreSQL, migraciones versionadas y utilidades de identidad.
- `backend/src/modules/imports/`: lectura, interpretación e importación idempotente de contratos.
- `frontend/src/api/`: único punto de acceso HTTP del cliente.
- `frontend/src/components/`: layout, tablas, modales, formularios y estados reutilizables.
- `frontend/src/pages/`: composición de cada pantalla del producto.
- `tests/`: pruebas de parser, persistencia e integración HTTP.

## Reglas de dependencia

1. El frontend solo conoce `/api`.
2. Los módulos de negocio pueden depender de `database`, nunca del frontend.
3. `server.js` ensambla y arranca; no contiene reglas de negocio.
4. Los archivos externos se conservan y se relacionan mediante hash y ruta absoluta.

## Siguiente evolución

Cuando un flujo crezca, debe salir de `app.js` hacia `backend/src/modules/<nombre>/`, separando `routes`, `service`, `repository` y validaciones. Esta estructura permite hacerlo endpoint por endpoint sin reescribir el sistema.
