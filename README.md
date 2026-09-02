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

Las pruebas procesan el contrato PDF real, verifican las relaciones generadas, las 12 cuotas, la idempotencia por hash y la validación del porcentaje.

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

## Modelo de datos

La base PostgreSQL incluye configuración, personas, propiedades, titulares, contratos, garantías, cuotas, pagos, incidencias, caja, documentos, importaciones y auditoría. Los archivos originales permanecen en disco; PostgreSQL guarda su ruta, huella y texto extraído para trazabilidad.
