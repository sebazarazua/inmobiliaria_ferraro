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

Requiere Node.js 22 o superior.

```powershell
pnpm install
pnpm db:up
pnpm start
```

Abrir [http://127.0.0.1:4173](http://127.0.0.1:4173). PostgreSQL 17 persiste sus datos en un volumen Docker y la carpeta observada se puede cambiar desde Configuración.

## Pruebas

```powershell
pnpm test
```

Las pruebas crean un clúster PostgreSQL temporal y una carpeta de contratos aislada; nunca usan la base de `.env`. Requieren binarios PostgreSQL (`PG_BIN`, o PostgreSQL 18 en su ubicación habitual de Windows; en Linux, `initdb` y `pg_ctl` en PATH). Cubren importaciones, cuotas, pagos, IPC oficial, rezagos, persistencia, conciliación y concurrencia.

```powershell
pnpm test:ipc
pnpm test:ipc:live
pnpm test:browser
```

La prueba `live` consulta Internet. La prueba de navegador requiere Chrome y Playwright CLI ya instalado (`PLAYWRIGHT_CLI` permite indicar la ruta de `playwright-cli.js`). No se agregó una dependencia de ejecución.

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

La migración nueva es `013_ipc_calculation_and_reconciliation.sql`. Leé [la guía de implementación y despliegue](docs/IPC_IMPLEMENTACION.md) antes de actualizar una instalación con datos. `AUTO_MIGRATE=false` desactiva las migraciones al iniciar; `pnpm db:migrate` exige un `DATABASE_URL` explícito en el entorno.

## Modelo de datos

La base PostgreSQL incluye configuración, personas, propiedades, titulares, contratos, garantías, cuotas, pagos, incidencias, caja, documentos, importaciones y auditoría. Los archivos originales permanecen en disco; PostgreSQL guarda su ruta, huella y texto extraído para trazabilidad.
