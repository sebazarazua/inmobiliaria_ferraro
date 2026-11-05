# Ferraro Propiedades

Sistema local de administración de alquileres para Eugenio A. Ferraro Propiedades. Centraliza contratos, inmuebles, titulares, inquilinos, cobros, gastos, incidencias y documentación, reemplazando planillas dispersas por una operación trazable.

## Funcionalidad principal

- Supervisa la carpeta `contratos/` cada 30 segundos.
- Lee cada PDF nuevo y extrae propiedad, propietarios, inquilino, vigencia, canon, ajuste, CBU y garantía.
- Asocia personas por DNI y propiedades por dirección normalizada; si no existen, las crea.
- Evita duplicados mediante SHA-256 del documento.
- Genera las cuotas mensuales según la duración del contrato.
- Envía a revisión los datos contradictorios o proveedores de garantía fuera de Respaldar/Argenprop.
- Registra transferencias, incidencias e ingresos/gastos generales.
- Valida el honorario de administración entre 2% y 5%.

## Ejecutar

Requiere Node.js 22+, pnpm y binarios PostgreSQL 17 (en macOS: `PG_BIN=/opt/homebrew/opt/postgresql@17/bin`).

Para usar la cartera real de Ferraro:

```sh
pnpm install --frozen-lockfile
pnpm app
```

Abrir http://127.0.0.1:4173. `pnpm app` (alias de `pnpm start`) utiliza exclusivamente PROD registrada y verificada. No ejecuta seeds ni migraciones y no cambia de base ante errores. Si falta una migración, bloquea el inicio: preparar el respaldo y pedir autorización antes de actualizar. Ver [la corrección de apertura real](docs/APERTURA_CARTERA_REAL.md).

Para desarrollar, `pnpm db:dev:setup` y `pnpm dev` utilizan DEV independiente, sin crear personas, propiedades, contratos ni cuotas. Los tests usan fixtures exclusivamente en clústeres temporales. No usar DEV para consultar la cartera real ni cambiar `DATABASE_URL` al alternar comandos.

Detener el backend anterior antes de cambiar entre `pnpm app` y `pnpm dev`: comparten el puerto 4173 y se rechaza un segundo backend. Los procedimientos completos están en [entornos, respaldos y migraciones](docs/POSTGRES_ENTORNOS_MIGRACIONES.md).

## Pruebas

```powershell
pnpm test
```

Las pruebas crean un clúster PostgreSQL temporal y una carpeta de contratos aislada; nunca usan la base de `.env`. Requieren binarios PostgreSQL (`PG_BIN`; se detectan Homebrew 17 en macOS y paquetes 17/16 en Ubuntu). Windows requiere configurar sus binarios y no fue verificado en esta entrega. Cubren importaciones, cuotas, pagos, IPC oficial, rezagos, persistencia, conciliación y concurrencia.

```powershell
pnpm test:ipc
pnpm test:ipc:live
pnpm test:browser
```

La prueba `live` consulta Internet. La prueba de navegador requiere Chrome, WebKit y Playwright CLI ya instalado (`UX_BROWSERS=chrome,webkit`) (`PLAYWRIGHT_CLI` permite indicar la ruta de `playwright-cli.js`). No se agregó una dependencia de ejecución.

Validación rápida de sintaxis:

```powershell
pnpm check
```

## Estructura

```text
backend/src/
  config/                 Configuración y rutas
  database/               Pool y acceso a PostgreSQL
  modules/imports/        Lectura e importación de contratos
  app.js                  Aplicación HTTP y API
  server.js               Inicio y cierre del proceso
frontend/
  src/api/                Cliente HTTP
  src/components/         Componentes reutilizables
  src/hooks/              Estado y carga de datos
  src/pages/              Pantallas funcionales
  src/utils/              Formato y reglas de presentación
  dist/                   Build servido por el backend
tests/                    Pruebas automatizadas
docs/                     Decisiones y arquitectura
contratos/                Carpeta supervisada de PDFs
database/migrations/      Esquema SQL versionado
```

La guía de dependencias y evolución está en `docs/ARCHITECTURE.md`.

## IPC y actualización de alquileres

El sistema guarda los niveles oficiales de INDEC y sus versiones. Calcula y persiste los aumentos al crear o importar un contrato, conserva el último canon calculable si falta un índice y consulta fuentes oficiales cada 12 horas. El registro de pagos utiliza la obligación persistida y conserva los ajustes pendientes.

En **Configuración → IPC oficial y conciliación de alquileres** se puede actualizar la fuente, simular diferencias históricas, revisar las cláusulas y aplicar una conciliación con trazabilidad. Las cuotas anteriores a esta versión requieren esa revisión antes de incorporarse a las actualizaciones automáticas.

La convención de rezago es: 0 o ausente equivale a 1; 1 usa el mes anterior; 2 usa dos meses anteriores. Se desplazan tanto la base como la comparación.

La migración nueva es `013_ipc_calculation_and_reconciliation.sql`. Leé [la guía de implementación y despliegue](docs/IPC_IMPLEMENTACION.md) antes de actualizar una instalación con datos. En PROD se prohíbe migrar al iniciar, incluso con `AUTO_MIGRATE=true`. `pnpm db:migrate` es ahora un alias de migración exclusiva de DEV. Las instalaciones reales usan `db:prod:prepare`, revisión humana y `db:prod:migrate --confirm UUID`; ver la guía de entornos.

## Modelo de datos

La base PostgreSQL incluye configuración, personas, propiedades, titulares, contratos, garantías, cuotas, pagos, incidencias, caja, documentos, importaciones y auditoría. Los archivos originales permanecen en disco; PostgreSQL guarda su ruta, huella y texto extraído para trazabilidad.
