/**
 * Fluxio – Portal de Avance
 * Cloudflare Worker: sirve el dashboard (assets en /public) y expone
 * GET /api/progress con los datos agregados de ClickUp.
 *
 * Secrets / vars (ver README):
 *   CLICKUP_TOKEN      (secret)  token personal de ClickUp
 *   LIST_ID            (var)     lista Backlog de Fluxio  -> 901714032948
 *   COMPONENT_ITEM_IDS (var)     ids de task type Componente, csv -> "1016"
 *   ACCESS_KEY         (secret, opcional) clave del enlace para el cliente
 */

const PORTAL_FIELD_ID = "7916e9a9-58bc-4282-8f2f-5c504c5ecb8b";
const IMPACT_FIELD_ID = "f0f7e5ee-26bd-4dfa-92aa-f95dc0aff4c6";
const CACHE_SECONDS = 60;

let memCache = { data: null, ts: 0 };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Acceso opcional por clave (?key=...) con cookie de sesión ---
    if (env.ACCESS_KEY) {
      const cookieOk = (request.headers.get("Cookie") || "").includes(`fpx=${env.ACCESS_KEY}`);
      const keyParam = url.searchParams.get("key");
      if (!cookieOk && keyParam !== env.ACCESS_KEY) {
        return new Response("Acceso restringido. Solicita el enlace de acceso a tu contacto de Fluxio.", {
          status: 401,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      if (!cookieOk && keyParam === env.ACCESS_KEY) {
        // fija cookie y limpia la clave de la URL
        url.searchParams.delete("key");
        return new Response(null, {
          status: 302,
          headers: {
            Location: url.pathname + url.search,
            "Set-Cookie": `fpx=${env.ACCESS_KEY}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
          },
        });
      }
    }

    if (url.pathname === "/api/progress") {
      try {
        const data = await getProgress(env);
        return json(data);
      } catch (err) {
        return json({ error: String(err && err.message || err) }, 502);
      }
    }

    return env.ASSETS.fetch(request);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function getProgress(env) {
  const now = Date.now();
  if (memCache.data && now - memCache.ts < CACHE_SECONDS * 1000) return memCache.data;

  const tasks = await fetchAllTasks(env);
  const componentTypeIds = String(env.COMPONENT_ITEM_IDS || "1016")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter(Boolean);

  const isComponent = (t) => componentTypeIds.includes(Number(t.custom_item_id));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const components = tasks.filter(isComponent);
  const byParent = new Map();
  for (const t of tasks) {
    if (!t.parent) continue;
    if (!byParent.has(t.parent)) byParent.set(t.parent, []);
    byParent.get(t.parent).push(t);
  }

  // Portal heredado: un componente anidado toma el Portal de su ancestro más cercano.
  function portalOf(task) {
    let cur = task;
    for (let i = 0; cur && i < 10; i++) {
      const v = dropdownValue(cur, PORTAL_FIELD_ID);
      if (v) return v;
      cur = cur.parent ? taskById.get(cur.parent) : null;
    }
    return null;
  }

  function parentComponentOf(task) {
    let cur = task.parent ? taskById.get(task.parent) : null;
    for (let i = 0; cur && i < 10; i++) {
      if (isComponent(cur)) return cur;
      cur = cur.parent ? taskById.get(cur.parent) : null;
    }
    return null;
  }

  const portalsSeen = new Set();
  const items = components.map((c) => {
    const portal = portalOf(c) || "Sin portal";
    portalsSeen.add(portal);
    // Solo tareas simples: los componentes anidados tienen su propia barra.
    const children = (byParent.get(c.id) || []).filter((t) => !isComponent(t));

    let doneImpact = 0, activeImpact = 0, doneTasks = 0, activeTasks = 0, noImpact = 0;
    const detail = [];
    for (const ch of children) {
      const impact = numberValue(ch, IMPACT_FIELD_ID);
      const completed = isCompleted(ch);
      if (impact == null) noImpact++;
      else if (completed) doneImpact += impact;
      else activeImpact += impact;
      if (completed) doneTasks++; else activeTasks++;
      detail.push({ name: ch.name, impact, completed, status: ch.status && ch.status.status });
    }

    const total = doneImpact + activeImpact;
    const parentComp = parentComponentOf(c);
    return {
      id: c.id,
      name: c.name,
      url: c.url,
      status: c.status && c.status.status,
      completed: isCompleted(c),
      portal,
      parentComponentId: parentComp ? parentComp.id : null,
      depth: 0,
      doneImpact,
      activeImpact,
      totalImpact: total,
      pct: total > 0 ? Math.round((doneImpact / total) * 100) : null,
      doneTasks,
      activeTasks,
      noImpactTasks: noImpact,
      tasks: detail,
    };
  });

  // Orden en árbol: componentes raíz por impacto total, y cada componente
  // anidado justo debajo de su padre, con depth para indentar en el dashboard.
  const byParentComp = new Map();
  for (const it of items) {
    const key = it.parentComponentId || "__root__";
    if (!byParentComp.has(key)) byParentComp.set(key, []);
    byParentComp.get(key).push(it);
  }
  const cmp = (a, b) => (b.totalImpact - a.totalImpact) || a.name.localeCompare(b.name);
  const ordered = [];
  (function walk(key, depth) {
    const group = (byParentComp.get(key) || []).sort(cmp);
    for (const it of group) {
      it.depth = depth;
      ordered.push(it);
      walk(it.id, depth + 1);
    }
  })("__root__", 0);
  // Componentes anidados cuyo padre no está en la lista (caso raro): al final.
  for (const it of items) if (!ordered.includes(it)) { it.depth = 0; ordered.push(it); }

  const data = {
    updatedAt: new Date().toISOString(),
    cacheSeconds: CACHE_SECONDS,
    portals: [...portalsSeen].sort(),
    components: ordered,
  };
  memCache = { data, ts: now };
  return data;
}

async function fetchAllTasks(env) {
  const listId = env.LIST_ID || "901714032948";
  const all = [];
  for (let page = 0; page < 30; page++) {
    const res = await fetch(
      `https://api.clickup.com/api/v2/list/${listId}/task?page=${page}&subtasks=true&include_closed=true`,
      { headers: { Authorization: env.CLICKUP_TOKEN } }
    );
    if (!res.ok) throw new Error(`ClickUp API ${res.status}: ${await res.text()}`);
    const body = await res.json();
    const batch = body.tasks || [];
    all.push(...batch);
    if (body.last_page === true || batch.length === 0) break;
  }
  return all;
}

function field(task, fieldId) {
  return (task.custom_fields || []).find((f) => f.id === fieldId);
}

// Dropdown: la API entrega el orderindex (número) o el id de la opción.
function dropdownValue(task, fieldId) {
  const f = field(task, fieldId);
  if (!f || f.value == null || f.value === "") return null;
  const options = (f.type_config && f.type_config.options) || [];
  const opt = options.find((o) => o.orderindex === f.value || o.id === f.value);
  return opt ? opt.name : null;
}

function numberValue(task, fieldId) {
  const f = field(task, fieldId);
  if (!f || f.value == null || f.value === "") return null;
  const n = parseFloat(f.value);
  return Number.isFinite(n) ? n : null;
}

function isCompleted(task) {
  const type = task.status && task.status.type;
  return type === "done" || type === "closed";
}
