# Apertura de Ferraro con su cartera real

Corrección sobre HEAD `d48751f` (`fix n1 migraciones bd`), 5 de noviembre de 2026. Cambios locales sin commit ni push. Esta guía reemplaza las indicaciones anteriores que proponían abrir una cartera ficticia para el uso cotidiano.

## Comandos y destino

| Comando | Base y comportamiento |
| --- | --- |
| `pnpm app` / `pnpm start` | PROD original registrada: `127.0.0.1:54329/inmobiliaria`. Compila el frontend y verifica conexión, identidad física, OID, checksums y esquema en una transacción de solo lectura antes de iniciar. No migra, no ejecuta seeds y no cambia de destino ante errores. Servirá el sistema en http://127.0.0.1:4173 cuando el esquema sea compatible. |
| `pnpm dev` | DEV independiente. Permite migraciones sólo después de validar su identidad. Sin personas, propiedades, contratos o cuotas inventados. No es la cartera real. |
| `pnpm db:dev:setup` | Prepara esquema y configuración técnica DEV, sin generar cartera. No borra datos que un desarrollador haya cargado antes. |
| `pnpm db:dev:reset` | Sólo DEV identificado y sin sesiones activas. Archiva su clúster anterior y crea uno vacío. Nunca opera sobre PROD. |
| `pnpm test` | Clúster nuevo temporal; mantiene todas las fixtures sintéticas dentro de las suites aisladas. |
| `pnpm db:status -- --env prod` / `pnpm db:diagnose -- --env prod` | Consulta real de solo lectura. |

No editar `DATABASE_URL` al alternar comandos. Se conserva la conexión original y el manifiesto PROD. `AUTO_MIGRATE=true` sigue prohibido en PROD y su ausencia equivale a false. Cambiar la URL respecto del manifiesto o presentar un marcador DEV como PROD bloquea el inicio.

Detener el backend anterior con Ctrl+C antes de cambiar de entorno. El launcher verifica el puerto, rechaza un segundo backend y no elige otro puerto silenciosamente. El servidor informa también una colisión que ocurra después de esa comprobación. Las barreras de escucha local siguen vigentes. No se modificaron UI ni branding ni se añadió una etiqueta PROD a una conexión DEV.

## Origen y corrección de los datos ficticios

`backend/src/database/development.js:seedDev()` insertaba un inquilino, una propiedad y un contrato `DEV-SINTETICO`, y llamaba a `generateInstallments()` para generar sus cuotas. Se invocaba desde `db:dev:setup` y desde `resetDev()`.

Se eliminó esa función del código de la aplicación y sus llamadas. La prueba DB09 verifica ahora DEV vacío; las fixtures necesarias siguen dentro de `tests/`. La instancia local DEV previamente creada se detuvo y archivó mediante el reset protegido, sin tocar PROD. El DEV actual tiene cero personas, propiedades, contratos y cuotas; sus cuatro endpoints correspondientes respondieron 200 y listas vacías. Después de verificarlo se detuvo DEV para no confundirlo con la aplicación cotidiana.

Se agregó `pnpm app` como alias del arranque PROD. `backend/src/lib/startup.js` realiza el preflight de solo lectura y la comprobación de puerto. El launcher imprime el entorno y destino verificados; no inicia el servidor ni sus tareas cuando falta una migración. `server.js` maneja explícitamente una colisión de puerto. Se conservan los módulos financieros y sus automatismos existentes: esta corrección elimina la creación de cartera ficticia, no cambia cálculos ni reglas de negocio.

## Estado real verificado

Se realizó diagnóstico de solo lectura antes de editar y se guardó un snapshot privado fuera del repositorio. Se comparó nuevamente después de las pruebas, del ensayo de migración y del cambio de entorno.

- Identidad original: clúster `7702592565026316322`, base `inmobiliaria`, OID `16384`.
- Un contrato, en estado **Revisión**, con propiedad e inquilino existentes correctamente vinculados. No se cambió ese estado.
- Doce cuotas de junio de 2026 a mayo de 2027, todas Pendientes: cuatro cánones de ARS 420.000,00 y ocho de ARS 452.809,95. Se conservaron exactamente importes y estados.
- Un servicio confirmado, proyección neta ARS 120.000,00 en junio; tres gastos no anulados, por ARS 3.109,00. Sin pagos registrados ni punitorios aplicados en las cuotas. No se reinterpretaron estos registros.
- Un PDF asociado al contrato, presente en disco y con SHA-256 coincidente con la base. No se reimportó ni modificó.
- Cero registros de los identificadores/nombres del antiguo seed en PROD. El snapshot completo de todas las tablas públicas, esquema, secuencias y saldos siguió idéntico, lo que también descarta inserciones nuevas distintas de esos nombres.
- Sin discrepancias de moneda, proyección de servicios, vínculos de gastos, estados/saldos o créditos detectadas por el diagnóstico.

No se borró, renombró, reseteó ni recreó la base original; no se añadió otra producción. No se copiaron datos ficticios, ejecutaron seeds o escribieron datos de negocio en PROD. `.env`, conexión original, SQL 001–018 y lockfile no fueron modificados.

## Preparación de 018 previa a la autorización

Al preparar esta corrección, PROD conservaba 001–017. **018 estaba pendiente**, y `pnpm app` se bloquea con su nombre e instrucciones; no se debilitó la compatibilidad para abrir el sistema.

Se ejecutó `pnpm db:prod:prepare`. El respaldo quedó en la carpeta privada externa habitual, se restauró realmente en un clúster aislado y allí se aplicó 018. El ensayo verificó la conservación de todas las filas y columnas anteriores y los saldos mediante el procedimiento existente. La copia temporal se eliminó; el respaldo se conserva según la política vigente. La fuente no fue migrada.

Preparación de esta ejecución: `b0ecc82e-c25a-4630-a3b4-98795eec5bbc`, válida hasta **2026-11-05 18:45:35 UTC** (15:45:35 de Buenos Aires). No se incluyen credenciales, registros completos ni respaldo en este documento.

Sólo después de autorización humana explícita:

```sh
pnpm db:prod:migrate -- --confirm b0ecc82e-c25a-4630-a3b4-98795eec5bbc
pnpm db:prod:verify
pnpm app
```

Si la preparación venció o cambió el estado, repetir primero `pnpm db:prod:prepare`, revisar su ensayo y usar el UUID nuevo. Detener todos los escritores antes de preparar/aplicar; no utilizar el UUID como sustituto de la autorización del usuario. La verificación posterior se ejecuta antes de reanudar operaciones normales. La migración real y la comprobación visual estaban pendientes de esa autorización; ver el cierre autorizado a continuación.

## Validación

- `pnpm test`: **224 casos, 223 aprobados, 0 fallos, 1 omitido** (OCR nativo no instalado en esta Mac).
- `pnpm check`: aprobado, incluyendo privacidad, sintaxis, gateway y build.
- Cinco casos nuevos DB21–DB25: DEV vacío y repetible sin afectar PROD de prueba, launcher cotidiano bloqueado por 018 sin escrituras, preflight PROD compatible sin seeds, puerto ocupado y rechazo de conexiones/etiquetas cruzadas. DB09 conserva prueba de reset pero exige cartera vacía.
- `pnpm app` contra el destino real: bloqueo esperado por 018, sin iniciar el backend ni escribir.
- `pnpm dev` real local: endpoints de contratos, propiedades, inquilinos y pendientes respondieron 200 y cero filas; se detuvo después de verificar.
- `git diff --check`: aprobado. No se modificaron CI, IPC, Servicios, Gastos, Punitorios, Cobros Pendientes, contratos/PDFs ni migraciones históricas.

Se verificó el [run publicado de GitHub Actions 42076846622](https://github.com/sebazarazua/inmobiliaria_ferraro/actions/runs/42076846622), correspondiente a `d48751f`: privacidad y check/pruebas aprobados, **219/219 sin omisiones**, incluido OCR nativo E10. El job de navegador quedó omitido por ser un push, según la configuración existente. Eso valida el HEAD publicado, no estos cambios locales: el CI de esta corrección sólo podrá verificarse después de una publicación autorizada. No se hizo commit ni push ni se disparó un workflow remoto.

Logs sintéticos locales ignorados por Git en `tmp/real-app-verification/`. Los snapshots y respaldos reales permanecen privados fuera del repositorio.


## Cierre autorizado — 5 de noviembre de 2026

El usuario autorizó expresamente aplicar 018. Se revalidaron identidad, UUID, firma, vigencia y SHA-256 del respaldo de la preparación `b0ecc82e-c25a-4630-a3b4-98795eec5bbc`; seguía vigente y no había backends abiertos.

Se ejecutó el comando de migración confirmado y se aplicó únicamente `018_financial_integrity.sql`. El procedimiento devolvió `verified: true`. Inmediatamente después, **antes de abrir la aplicación**, `pnpm db:prod:verify` pasó: versión 018, doce cuotas y preservación de todos los registros anteriores y del resumen financiero.

Después se abrió `pnpm app`, que verificó y utilizó `127.0.0.1:54329/inmobiliaria`. Ferraro quedó funcionando en **http://127.0.0.1:4173**. Los endpoints respondieron 200: un contrato, doce pendientes, tres gastos y dashboard. Chrome mostró Contratos y Cobros pendientes sin el error de carga y sin datos del seed. No se registraron pagos, servicios, gastos o contratos de prueba.

Una repetición de `db:prod:verify` después de abrir la aplicación rechazó la comparación con el snapshot anterior por cambios en auditoría. Se inspeccionó en solo lectura: los automatismos existentes habían actualizado exclusivamente `audit_log`, `ipc_refresh_state`, `late_fee_rate_sources`, `late_fee_rates` y `late_fee_sync_state`; la auditoría registra incorporaciones de tasas oficiales. El resumen financiero seguía idéntico y los hashes de contratos, personas, propiedades, cuotas, pagos, servicios, gastos y documentos permanecieron iguales. La comparación congelada debe ejecutarse antes de reanudar automatismos, como indica el procedimiento: ese rechazo posterior no revierte ni invalida la migración ya verificada.

Se conserva el respaldo privado externo y el recibo firmado de la migración. DEV no quedó en ejecución. No se modificó ninguna fórmula financiera, ni se hizo commit o push.
