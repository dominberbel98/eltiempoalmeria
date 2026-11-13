// Cron externo de eltiempoalmeria.es (Cloudflare Worker con cron trigger).
// GitHub no cumple el `schedule` de 15 min del workflow de despliegue (lo lanza 3-5 veces al día), así que este Worker
// lo dispara con workflow_dispatch cada 15 min. Los TTL de scripts/fuentes/ impiden gastar de más si llegan disparos
// de sobra, y el grupo de concurrencia "pages" encola las ejecuciones que se pisen.
//
// Secreto (no va al repositorio): GH_TOKEN, un token fine-grained de GitHub limitado al repositorio y con el único
// permiso "Actions: Read and write". Se guarda con: npx wrangler secret put GH_TOKEN --config cron/wrangler.toml
// Despliegue: npx wrangler deploy --config cron/wrangler.toml

const REPO = "dominberbel98/eltiempoalmeria";
const WORKFLOW = "deploy.yml";
const RAMA = "main";

async function disparar(env) {
  if (!env.GH_TOKEN) throw new Error("Falta el secreto GH_TOKEN");
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "cron-eltiempoalmeria",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: RAMA }),
  });
  // 204 sin cuerpo si se ha aceptado
  if (r.status !== 204) throw new Error(`GitHub respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export default {
  async scheduled(_evento, env, ctx) {
    // Si falla, la invocación queda como error en el panel de Cloudflare (Workers > Logs)
    ctx.waitUntil(disparar(env));
  },
  // Sin ruta pública útil: el Worker solo trabaja con el cron
  async fetch() {
    return new Response("Cron de eltiempoalmeria.es", { status: 200 });
  },
};
