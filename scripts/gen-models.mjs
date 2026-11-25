// Крючок будущего 3D: генерация моделей через Meshy / Tripo / Rodin.
// Запуск (КОГДА появится 3D-рендер): node scripts/gen-models.mjs <id> "<prompt>"
// Ключи ТОЛЬКО из env: MESHY_API_KEY / TRIPO_API_KEY / RODIN_API_KEY.
// Результат: public/assets/models/<id>.glb + public/assets/models/manifest.json.
//
// Сейчас это заготовка + документация: без env-ключей скрипт печатает
// справку и выходит 0. НЕ запускать для генерации до принятия 3D-контура
// владельцем (тот же регламент подтверждений, что и для графики).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MODELS_DIR = path.join(ROOT, "public", "assets", "models");
const TIMEOUT_MS = 120000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function api(url, options = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function download(url, outPath) {
  const res = await api(url);
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

// Meshy: text-to-3d preview → опрос задачи → glb
async function genMeshy(prompt, key) {
  const submit = await api("https://api.meshy.ai/openapi/v2/text-to-3d", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "preview", prompt, art_style: "realistic" })
  });
  const { result } = await submit.json();
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const poll = await api(`https://api.meshy.ai/openapi/v2/text-to-3d/${result}`, {
      headers: { "Authorization": `Bearer ${key}` }
    });
    const st = await poll.json();
    if (st.status === "SUCCEEDED") return st.model_urls.glb;
    if (st.status === "FAILED") throw new Error("Meshy: FAILED");
  }
  throw new Error("Meshy: таймаут");
}

// Tripo: text_to_model → опрос → pbr-модель
async function genTripo(prompt, key) {
  const submit = await api("https://api.tripo3d.ai/v2/openapi/task", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "text_to_model", prompt })
  });
  const { data } = await submit.json();
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const poll = await api(`https://api.tripo3d.ai/v2/openapi/task/${data.task_id}`, {
      headers: { "Authorization": `Bearer ${key}` }
    });
    const st = await poll.json();
    if (st.data.status === "success") return st.data.output.pbr_model;
    if (st.data.status === "failed") throw new Error("Tripo: failed");
  }
  throw new Error("Tripo: таймаут");
}

// Rodin (HyperHuman): gen → опрос статуса → список файлов
async function genRodin(prompt, key) {
  const submit = await api("https://hyperhuman.deemos.com/api/v2/gen", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, geometry_quality: "medium" })
  });
  const { uuid } = await submit.json();
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    const poll = await api("https://hyperhuman.deemos.com/api/v2/status", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subscription_key: uuid })
    });
    const st = await poll.json();
    const jobs = st.jobs || [];
    if (jobs.length && jobs.every(j => j.status === "Done")) {
      const dl = await api("https://hyperhuman.deemos.com/api/v2/download", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ task_uuid: uuid })
      });
      const files = await dl.json();
      const glb = (files.list || []).find(f => f.name.endsWith(".glb"));
      if (!glb) throw new Error("Rodin: нет glb");
      return glb.url;
    }
    if (jobs.some(j => j.status === "Failed")) throw new Error("Rodin: Failed");
  }
  throw new Error("Rodin: таймаут");
}

async function main() {
  const [id, prompt] = process.argv.slice(2);
  const meshy = process.env.MESHY_API_KEY;
  const tripo = process.env.TRIPO_API_KEY;
  const rodin = process.env.RODIN_API_KEY;

  if (!meshy && !tripo && !rodin) {
    console.log("3D-крючок: env-ключи MESHY_API_KEY / TRIPO_API_KEY / RODIN_API_KEY не заданы.");
    console.log("Модели сохраняются в public/assets/models/<id>.glb + manifest.json;");
    console.log("рендер — three.js, тот же регламент подтверждений владельца (ДЕПЛОЙ ТЕСТ / ПРИНИМАЮ ПРОД).");
    console.log("Сейчас скрипт НЕ запускается для генерации.");
    return;
  }

  if (!id || !prompt) {
    console.error("Использование: node scripts/gen-models.mjs <id> \"<prompt>\"");
    process.exit(1);
  }

  const provider = meshy ? "meshy" : tripo ? "tripo" : "rodin";
  const url =
    provider === "meshy" ? await genMeshy(prompt, meshy) :
    provider === "tripo" ? await genTripo(prompt, tripo) :
    await genRodin(prompt, rodin);

  fs.mkdirSync(MODELS_DIR, { recursive: true });
  await download(url, path.join(MODELS_DIR, `${id}.glb`));

  const manifestPath = path.join(MODELS_DIR, "manifest.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : { models: {} };
  manifest.models[id] = { file: `${id}.glb`, provider, prompt };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[ok] ${id}.glb (${provider})`);
}

main();
