import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { loadModule } from "cld3-asm";

// ---- config (env-friendly) ----
const PORT = Number(process.env.PORT || 7860);
// Jeśli serwis ma być tylko lokalnie (host network + Flowise), ustaw HOST=127.0.0.1
const HOST = process.env.HOST || "127.0.0.1";

const BODY_LIMIT = Number(process.env.BODY_LIMIT || 64 * 1024); // 64KB
const CACHE_MAX = Number(process.env.CACHE_MAX || 5000);        // 0 = off
const MIN_LEN = Number(process.env.MIN_LEN || 10);              // 0 = off
const CLD_MIN_BYTES = Number(process.env.CLD_MIN_BYTES || 0);
const CLD_MAX_BYTES = Number(process.env.CLD_MAX_BYTES || 1000);

// Przytnij wejście (ważne, jeśli ktoś wyśle historię czatu)
const MAX_INPUT_CHARS = Number(process.env.MAX_INPUT_CHARS || 4000);

const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 0); // 0 = off
const RATE_LIMIT_TIME = process.env.RATE_LIMIT_TIME || "1 minute";

// Logowanie potrafi zjadać CPU przy dużym RPS
const LOGGER = process.env.LOGGER === "1";

// ---- tiny LRU (no deps) ----
class LRU {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, val) {
    if (this.max <= 0) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.max) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
}

const cache = new LRU(CACHE_MAX);

// ---- fast hash for cache keys (FNV-1a 32-bit) ----
function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---- fastify instance ----
const app = Fastify({
  logger: LOGGER,
  bodyLimit: BODY_LIMIT,
  trustProxy: true
});

// Security headers (tanie, rozsądne). CSP wyłączone, bo to API.
await app.register(helmet, { contentSecurityPolicy: false });

// Rate limit (opcjonalnie)
if (RATE_LIMIT_MAX > 0) {
  await app.register(rateLimit, {
    max: RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_TIME
  });
}

// ---- CLD3 init ----
let identifier = null;

async function initDetector() {
  const factory = await loadModule();
  identifier = factory.create(CLD_MIN_BYTES, CLD_MAX_BYTES);
  app.log?.info?.({ CLD_MIN_BYTES, CLD_MAX_BYTES }, "cld3-asm ready");
}

await initDetector();

// ---- health/ready ----
app.get("/health", async () => ({ ok: true }));

app.get("/ready", async (req, reply) => {
  if (!identifier) return reply.code(503).send({ ok: false });
  return { ok: true };
});

// ---- classify ----
// POST { "text": "...", "topN": 1|3|5 }  (topN optional)
app.post(
  "/classify",
  {
    schema: {
      body: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", minLength: 1 },
          topN: { type: "integer", minimum: 1, maximum: 10 }
        },
        additionalProperties: false
      }
    }
  },
  async (req, reply) => {
    if (!identifier) return reply.code(503).send({ error: "Detector not ready yet." });

    const topN = req.body.topN || 1;

    // normalizacja wejścia + przycięcie
    const raw = String(req.body.text ?? "");
    const text = raw.trim().slice(0, MAX_INPUT_CHARS);

    if (!text) return reply.code(400).send({ error: "Empty 'text'." });

    // fast-fail dla krótkich wejść (opcjonalnie)
    if (MIN_LEN > 0 && text.length < MIN_LEN) {
      return {
        input_len: text.length,
        cld3: topN === 1
          ? { language: "und", probability: 0, is_reliable: false, proportion: 0 }
          : []
      };
    }

    // cache key: topN + hash + length (nie trzymamy całego tekstu jako klucza)
    const key = `${topN}:${fnv1a(text)}:${text.length}`;
    const hit = cache.get(key);
    if (hit) return hit;

    let result;
    if (topN === 1) {
      result = identifier.findLanguage(text);
    } else {
      result = identifier.findMostFrequentLanguages(text, topN);
    }

    const out = {
      input_len: text.length,
      cld3: result
    };

    cache.set(key, out);
    return out;
  }
);

// ---- graceful shutdown ----
async function shutdown(signal) {
  try {
    app.log?.info?.({ signal }, "shutting down");
    await app.close();
  } finally {
    try { identifier?.dispose?.(); } catch {}
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---- start ----
await app.listen({ port: PORT, host: HOST });
