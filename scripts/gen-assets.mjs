// Генерация ассетов по тексту (графика v2).
// Запуск: node scripts/gen-assets.mjs [id...] [--force]
// Без аргументов — весь каталог; с id — только указанные ассеты.
//
// Провайдеры (ключи ТОЛЬКО из env, не из чата):
//   по умолчанию — бесплатный pollinations (fetch, retry 3, таймаут);
//   DASHSCOPE_API_KEY — платный DashScope (wanx, async task);
//   OPENROUTER_API_KEY — платный OpenRouter (image-модель).
// Ответ провайдера может быть JPEG — конвертируем в PNG системным GDI+
// (scripts/lib/jpg2png.ps1), без сторонних npm-зависимостей.
// Результат: public/assets/raw/<id>.png (512x512), один ассет за запрос.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ASSETS } from "./lib/assets.mjs";
import { decodePNG } from "./lib/png.mjs";

const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const RAW_DIR = path.join(ROOT, "public", "assets", "raw");
const TIMEOUT_MS = 90000;
const RETRIES = 3;
// бесплатный провайдер душит частые запросы (HTTP 402): пауза между ассетами
const DELAY_MS = 15000;
const RATE_LIMIT_BACKOFF_MS = 60000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchRetry(url, options = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      console.log(`  попытка ${attempt}/${RETRIES} не удалась: ${e.message}`);
      if (attempt < RETRIES) {
        const rateLimited = /HTTP (402|429|503)/.test(e.message);
        await sleep(rateLimited ? RATE_LIMIT_BACKOFF_MS : 2000 * attempt);
      }
    }
  }
  throw lastErr;
}

// Бесплатный провайдер по умолчанию
async function genPollinations(prompt) {
  // model=flux: дефолтный провайдер даёт мыльную акварель вместо пиксель-арта
  const url =
    "https://image.pollinations.ai/prompt/" +
    encodeURIComponent(prompt) +
    "?width=512&height=512&nologo=true&model=flux";
  const res = await fetchRetry(url);
  return Buffer.from(await res.arrayBuffer());
}

// Платный DashScope: асинхронная задача text-to-image
async function genDashscope(prompt, key) {
  const submit = await fetchRetry(
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-to-image/generation",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable"
      },
      body: JSON.stringify({
        model: "wanx2.1-t2i-turbo",
        input: { prompt },
        parameters: { size: "512*512", n: 1 }
      })
    }
  );
  const task = await submit.json();
  const taskId = task.output?.task_id;
  if (!taskId) throw new Error(`DashScope: нет task_id (${JSON.stringify(task).slice(0, 200)})`);

  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const poll = await fetchRetry(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
      headers: { "Authorization": `Bearer ${key}` }
    });
    const st = await poll.json();
    const status = st.output?.task_status;
    if (status === "SUCCEEDED") {
      const imgUrl = st.output.results?.[0]?.url;
      if (!imgUrl) throw new Error("DashScope: нет url результата");
      const img = await fetchRetry(imgUrl);
      return Buffer.from(await img.arrayBuffer());
    }
    if (status === "FAILED") throw new Error("DashScope: задача FAILED");
  }
  throw new Error("DashScope: таймаут ожидания задачи");
}

// Платный OpenRouter: image-модель через chat completions
async function genOpenrouter(prompt, key) {
  const res = await fetchRetry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-image",
      modalities: ["image", "text"],
      messages: [{ role: "user", content: prompt }]
    })
  });
  const json = await res.json();
  const dataUrl = json.choices?.[0]?.message?.images?.[0]?.image?.url;
  if (!dataUrl) throw new Error("OpenRouter: нет image в ответе");
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

function jpegToPng(jpegBuf, outPath) {
  const tmp = path.join(os.tmpdir(), `gen-assets-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  fs.writeFileSync(tmp, jpegBuf);
  const ps1 = path.join(ROOT, "scripts", "lib", "jpg2png.ps1");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, tmp, outPath],
      { timeout: 60000 },
      (err) => {
        fs.rmSync(tmp, { force: true });
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

async function saveAsPng(bytes, outPath) {
  if (bytes.readUInt32BE(0) === 0x89504e47) {
    fs.writeFileSync(outPath, bytes);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    await jpegToPng(bytes, outPath);
  } else {
    throw new Error(`неизвестный формат ответа: ${bytes.slice(0, 4).toString("hex")}`);
  }
  const img = decodePNG(fs.readFileSync(outPath));
  return img;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const ids = args.filter(a => !a.startsWith("--"));
  const list = ids.length ? ASSETS.filter(a => ids.includes(a.id)) : ASSETS;

  if (ids.length && list.length !== ids.length) {
    const known = new Set(ASSETS.map(a => a.id));
    const bad = ids.filter(i => !known.has(i));
    console.error("Неизвестные id:", bad.join(", "));
    process.exit(1);
  }

  const dash = process.env.DASHSCOPE_API_KEY;
  const orouter = process.env.OPENROUTER_API_KEY;
  const provider = dash ? "dashscope" : orouter ? "openrouter" : "pollinations";
  console.log(`Провайдер: ${provider}; ассетов: ${list.length}`);

  fs.mkdirSync(RAW_DIR, { recursive: true });

  let done = 0;
  let failed = 0;
  let first = true;
  for (const asset of list) {
    if (!first) await sleep(DELAY_MS);
    first = false;
    const outPath = path.join(RAW_DIR, `${asset.id}.png`);
    if (!force && fs.existsSync(outPath)) {
      console.log(`[skip] ${asset.id} (уже есть; --force для перегенерации)`);
      done++;
      continue;
    }

    console.log(`[gen] ${asset.id}`);
    try {
      const bytes =
        provider === "dashscope" ? await genDashscope(asset.prompt, dash) :
        provider === "openrouter" ? await genOpenrouter(asset.prompt, orouter) :
        await genPollinations(asset.prompt);
      const img = await saveAsPng(bytes, outPath);
      console.log(`  ok ${img.width}x${img.height} ${fs.statSync(outPath).size} bytes`);
      done++;
    } catch (e) {
      console.log(`  FAIL ${asset.id}: ${e.message}`);
      failed++;
    }
  }

  console.log(`Готово: ${done}, ошибок: ${failed}`);
  process.exit(failed ? 1 : 0);
}

main();
