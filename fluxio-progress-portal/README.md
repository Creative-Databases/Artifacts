# Fluxio · Portal de Avance

Dashboard en vivo para el cliente de Fluxio: barras apiladas por **componente**
(task type "Componente" en ClickUp), divididas en impacto **completado** vs
**pendiente** (suma del campo `Impact` de las subtareas), con filtro por **Portal**.

Un solo Cloudflare Worker sirve el dashboard y el endpoint `/api/progress`.
El cliente solo abre una URL — no necesita cuenta de ClickUp.

## Cómo funciona

1. El Worker consulta la API de ClickUp (lista **Backlog** de Fluxio, `901714032948`),
   trayendo todas las tareas con subtareas y cerradas incluidas.
2. Detecta los componentes por `custom_item_id = 1016` (task type "Componente").
3. Agrupa las subtareas por su componente padre y suma `Impact`:
   - **Completado** = subtareas con status de tipo `done` o `closed` (done, Closed)
   - **Pendiente** = el resto (Open, pending, in progress, in review)
4. El Portal se lee del dropdown `Portal` del componente (Back Office, Cliente,
   Proveedor, Proyecto, Adm Finanzas).
5. Respuesta cacheada 60 s para no saturar la API de ClickUp.

Las subtareas **sin** valor en `Impact` no suman a la barra; se muestran como
"(+N sin estimar)" junto al nombre del componente.

**Componentes anidados** (un Componente como subtarea de otro Componente):
- Cada componente tiene su propia barra; los anidados se muestran indentados (↳)
  debajo de su componente padre.
- Cada tarea simple cuenta una sola vez, hacia su componente más cercano.
- El Portal se hereda: un componente anidado sin Portal toma el de su ancestro,
  así que solo hace falta poner Portal en los componentes de nivel superior.

## Deploy (una vez)

Requisitos: Node y una cuenta de Cloudflare (la misma de Datatlan sirve).

```bash
cd fluxio-progress-portal
npx wrangler login
npx wrangler secret put CLICKUP_TOKEN
npx wrangler deploy
```

- `CLICKUP_TOKEN`: token personal de ClickUp — en ClickUp: avatar → **Settings →
  Apps → API Token → Generate**. Empieza con `pk_`. Se pega cuando el comando lo pida.
- URL resultante: `https://fluxio-progress.<tu-subdominio>.workers.dev`
  (se puede colgar de un dominio propio después, p. ej. `avance.fluxio.mx`).

### Proteger el enlace (opcional pero recomendado)

```bash
npx wrangler secret put ACCESS_KEY
npx wrangler deploy
```

Define una clave (p. ej. `fluxio-2026-camilo`) y comparte al cliente el enlace
`https://...workers.dev/?key=fluxio-2026-camilo`. La clave queda en una cookie
30 días; sin ella responde 401.

## Configuración

En `wrangler.toml`:

| Var | Valor actual | Qué es |
|---|---|---|
| `LIST_ID` | `901714032948` | Lista Backlog del folder Fluxio |
| `COMPONENT_ITEM_IDS` | `1016` | Id del task type "Componente" (csv si hay más) |

IDs de campos (en `worker.js`): `Portal` = `7916e9a9-58bc-4282-8f2f-5c504c5ecb8b`,
`Impact` = `f0f7e5ee-26bd-4dfa-92aa-f95dc0aff4c6`.

## Desarrollo local

```bash
npx wrangler dev
```

Abrir `public/index.html` directo (sin Worker) muestra la **vista previa** con
datos de ejemplo (snapshot real del 25-ago-2026) y un badge "Vista previa".
