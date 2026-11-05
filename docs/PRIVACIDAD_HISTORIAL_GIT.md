# Privacidad del historial de Git

El repositorio es **público**. Retirar archivos del último commit **no** los elimina del historial: cualquier persona puede descargarlos desde commits anteriores.

## Inventario sanitizado (al commit `c153238`)

Generado con `pnpm audit:git-history`, que nunca imprime nombres de archivo:

| Categoría | Rutas | Commits |
|---|---|---|
| PDF de contratos (`contratos/`) y uno en `temp/` | 14 | `172896f` `9076609` `1b852c4` `13dcb86` `c4325da` `a29e291` `c153238` |
| Snapshots de navegador (`.playwright-cli/*.yml`) | 2 | 2 commits |
| Metadatos de carpeta (`.DS_Store`, raíz y `contratos/`) | 2 | 2 commits o más |
| `.env` reales | 0 | — |
| Volcados o copias de base de datos | 0 | — |

Contenido revisado en todos los commits en busca de tokens (Meta/WhatsApp, GitHub, AWS, claves privadas), contraseñas en URLs y CBU. **No se encontraron credenciales reales**: solo valores de ejemplo (`ferraro_local`, token de verificación por defecto). El CBU por defecto de `backend/src/database/index.js` es una cuenta de la inmobiliaria publicada en el código. Decidir si debe quedar en la configuración local.

Forks: 0 al momento de la revisión.

## Controles preventivos

- `.gitignore` excluye `contratos/`, `temp/`, `tmp/`, `.env`, `.playwright-cli/`, `*.dump`, `.DS_Store`.
- `backend/scripts/check-private-artifacts.js` (dentro de `pnpm check` y como primer job de CI) rechaza PDFs, `.env`, volcados, `.DS_Store`, snapshots y carpetas temporales en el índice.
- Las pruebas generan PDFs sintéticos (`tests/support/synthetic-contract.js`). CI no usa archivos reales ni sube capturas salvo en fallos de navegador, y esas contienen solo datos sintéticos y vencen en 3 días.
- `.DS_Store` quedó retirado del índice (`git rm --cached`). El archivo local se conserva.

## Saneamiento con `git-filter-repo` (NO ejecutado; requiere aprobación)

1. **Respaldo:** `git clone --mirror git@github.com:sebazarazua/inmobiliaria_ferraro.git respaldo-ferraro.git` en un disco cifrado y fuera del repositorio.
2. Clon espejo de trabajo: `git clone --mirror <url> ferraro-limpio.git && cd ferraro-limpio.git`.
3. Reescritura:
   ```
   git filter-repo --invert-paths \
     --path contratos/ --path temp/ --path tmp/ --path .playwright-cli/ \
     --path-glob '*.pdf' --path-glob '*.DS_Store'
   ```
4. Verificación: `git log --all --name-only | grep -Ei '\.pdf$|playwright-cli|DS_Store'` debe quedar vacío. Correr `pnpm check` y `pnpm test` sobre un clon nuevo.
5. Publicación coordinada: `git push --force --mirror`. Cambian **todos** los hashes; cada colaborador debe volver a clonar, porque un `pull` reintroduciría el historial viejo.
6. Si hubo Pull Requests, GitHub conserva sus referencias (`refs/pull/*`). Solicitar a GitHub Support la purga de cachés y vistas de commits huérfanos.
7. Alternativa mientras tanto: pasar el repositorio a **privado**. Requiere decisión del titular y no borra copias ya descargadas.

Riesgos: reescribir rompe enlaces a commits, forks y clones. No se puede garantizar el borrado de copias ya hechas. Como no se detectaron credenciales, no hace falta rotar claves por este motivo.
