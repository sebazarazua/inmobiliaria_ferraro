# Estabilización P1: operación y despliegue

## Migración 018 (`database/migrations/018_financial_integrity.sql`)

Aditiva. No modifica filas financieras existentes.

- **Unicidad gasto → cargo.** Si la historia no tiene duplicados crea `installment_services_expense_uq`, un índice único parcial sobre `expense_id`. Si los tiene, **no** crea el índice: los registra en `integrity_findings` para conciliación manual.
- **Trigger `installment_services_link_guard`.** Rechaza un segundo cargo para el mismo gasto, aunque el primero esté anulado. También rechaza la moneda distinta entre cargo y cuota o entre cargo y gasto. Funciona con o sin el índice y no revalida filas antiguas.
- **Recuperación BNA.** Crea `late_fee_sync_days`, con un estado por día de boletín consultado, y agrega `late_fee_sync_state.recovery_json`.

Probado sobre esquema 017 limpio, sobre historia con duplicados y sobre una copia de la base real (filas financieras idénticas antes y después).

## Recuperación de tasas BNA (`backend/src/modules/late-fees/sync.js`)

- **Cobertura requerida.** Va desde el vencimiento más antiguo de las cuotas en ARS, impagas o pagadas con atraso sin cálculo, de contratos cuya modalidad confirmada es BNA (o de la política interna BNA), hasta hoy. El tope es de 3 años; lo anterior se informa y requiere cargar el aviso a mano.
- **Ciclo automático (cada hora).** Revisa los últimos 7 días (cada 24 h si el estado es `ok`) y, además, hasta 14 días pendientes del atraso, empezando por los más recientes. Cada día queda persistido, así que un reinicio continúa donde quedó.
- **Estados por día.** Sin publicación, aviso sin la serie soportada, publicación verificada, error HTTP, sin conexión, formato no reconocido, aviso ilegible, contradicción.
  - Los errores se reintentan con espera creciente (1 h, 2 h, 4 h… hasta 24 h).
  - Las contradicciones no se reintentan y bloquean el reemplazo hasta que alguien las revise.
- **Sin conexión.** El ciclo se detiene al primer fallo de red, la cobertura guardada sigue disponible y los días sin tasa quedan bloqueados para el cálculo. Nunca se extrapolan tasas.

## OCR local

Diagnóstico: `GET /api/late-fees/ocr/status`. Los errores se clasifican como ejecutable faltante, idioma faltante, PDF ilegible, tiempo agotado o error de procesamiento.

Instalación en macOS (no realizada; requiere autorización):

```
brew install poppler tesseract tesseract-lang
tesseract --list-langs | grep spa
LATE_FEE_OCR=true   # en .env
PG_BIN=/opt/homebrew/opt/postgresql@17/bin node tests/run-isolated.js --test-name-pattern=E10 tests/stabilization.test.js
```

El test E10 se omite hasta que estén instalados. En CI se instalan `poppler-utils`, `tesseract-ocr` y `tesseract-ocr-spa`, y E10 se ejecuta.

## Diagnóstico de solo lectura

```
DATABASE_URL=postgresql://… pnpm db:diagnose
```

Corre en una única transacción `READ ONLY`, no migra y no escribe. Informa versión de migraciones, conteos, saldos a favor, estados inconsistentes, vínculos duplicados, monedas cruzadas, cobertura BNA y documentos faltantes. Solo muestra identificadores técnicos.

## Procedimiento de despliegue

> ⚠️ `openDatabase` aplica migraciones al arrancar salvo `AUTO_MIGRATE=false`, y `pnpm dev:api` usa `--watch`, que reinicia ante cualquier cambio del backend. Así se aplicó la 017 en la base real. **Antes de actualizar el código, definí `AUTO_MIGRATE=false` en `.env`.**

1. Detener el servidor (`pnpm dev`, `pnpm start` o el proceso `--watch`) y confirmar que no quedan conexiones de escritura (`pg_stat_activity`).
2. Respaldo consistente: `pg_dump --format=custom --file=ferraro-AAAAMMDD.dump "$DATABASE_URL"`. Guardarlo fuera del repositorio.
3. Verificar que el respaldo se restaura: `createdb ferraro_verificacion && pg_restore -d ferraro_verificacion ferraro-AAAAMMDD.dump`.
4. Probar las migraciones sobre esa copia: `DATABASE_URL=…/ferraro_verificacion pnpm db:migrate`.
5. Comparar `pnpm db:diagnose` sobre la copia antes y después. Los conteos y saldos deben coincidir; solo cambian el índice o los hallazgos y las tablas nuevas.
6. **Solicitar autorización explícita** para la base real.
7. Aplicar sobre la real: `DATABASE_URL=<real> pnpm db:migrate`.
8. Desplegar frontend y backend del mismo commit: `pnpm build`, y arrancar con `AUTO_MIGRATE=false`.
9. Ejecutar `pnpm db:diagnose` sobre la real y revisar `integrity_findings`.
10. Registrar commit, versión final de migraciones (`schema_migrations`) y resultado.
