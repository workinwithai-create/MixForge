import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const ALLOWED_STEMS = new Set(["vocals", "bass", "drums", "guitars", "keys", "other"]);
const ALLOWED_ORIGINS = [
  /^https:\/\/mix\.workinwithai\.com$/,
  /^https:\/\/mixforge\.workinwithai\.com$/,
  /^https:\/\/mix-forge(?:-[a-z0-9-]+)?\.vercel\.app$/,
  /^https:\/\/[a-z0-9-]+-release-forge\.vercel\.app$/,
  /^http:\/\/localhost(?::\d+)?$/,
];
const HOURLY_STEM_LIMIT = 12;
const DAILY_STEM_LIMIT = 30;

function isAllowedOrigin(origin: string) {
  return ALLOWED_ORIGINS.some((pattern) => pattern.test(origin));
}

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin) ? origin : "https://mix.workinwithai.com",
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
}

function response(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: cors(req) });
}

function safeStems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((stem): stem is string => typeof stem === "string" && ALLOWED_STEMS.has(stem)))].slice(0, 6);
}

function encodedPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function serverCredentials() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase service credentials are unavailable");
  return { supabaseUrl, serviceKey };
}

async function clientHash(req: Request) {
  const { serviceKey } = serverCredentials();
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
  const bytes = new TextEncoder().encode(`${address}:${serviceKey.slice(-24)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkUsageLimit(req: Request, requestedStemCount: number) {
  const { supabaseUrl, serviceKey } = serverCredentials();
  const ipHash = await clientHash(req);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const query = new URL(`${supabaseUrl}/rest/v1/mixforge_stem_usage`);
  query.searchParams.set("select", "stem_count,created_at");
  query.searchParams.set("ip_hash", `eq.${ipHash}`);
  query.searchParams.set("created_at", `gte.${since}`);
  const usageRes = await fetch(query, { headers: { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey } });
  const usage = await usageRes.json().catch(() => []);
  if (!usageRes.ok || !Array.isArray(usage)) throw new Error("Could not verify separation usage limits");
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const daily = usage.reduce((sum, row) => sum + Number(row.stem_count || 0), 0);
  const hourly = usage.filter((row) => new Date(row.created_at).getTime() >= hourAgo).reduce((sum, row) => sum + Number(row.stem_count || 0), 0);
  if (hourly + requestedStemCount > HOURLY_STEM_LIMIT) throw new Error("Hourly stem-separation limit reached. Try again later.");
  if (daily + requestedStemCount > DAILY_STEM_LIMIT) throw new Error("Daily stem-separation limit reached. Try again tomorrow.");
  return ipHash;
}

async function recordUsage(ipHash: string, requestedStemCount: number) {
  const { supabaseUrl, serviceKey } = serverCredentials();
  const insertRes = await fetch(`${supabaseUrl}/rest/v1/mixforge_stem_usage`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify({ ip_hash: ipHash, stem_count: requestedStemCount }),
  });
  if (!insertRes.ok) console.warn("Could not record successful separation usage");
}

async function signedSourceUrl(storagePath: string) {
  const { supabaseUrl, serviceKey } = serverCredentials();
  if (!/^uploads\/[a-zA-Z0-9._/-]+$/.test(storagePath) || storagePath.includes("..")) throw new Error("Invalid storage path");
  const signRes = await fetch(`${supabaseUrl}/storage/v1/object/sign/audio/${encodedPath(storagePath)}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  const signed = await signRes.json().catch(() => ({}));
  if (!signRes.ok) throw new Error(`Could not sign source audio (${signRes.status}): ${signed?.message || JSON.stringify(signed)}`);
  const raw = signed.signedURL || signed.signedUrl;
  if (!raw) throw new Error("Storage did not return a signed URL");
  if (String(raw).startsWith("http")) return String(raw);
  if (String(raw).startsWith("/storage/v1")) return `${supabaseUrl}${raw}`;
  return `${supabaseUrl}/storage/v1${String(raw).startsWith("/") ? "" : "/"}${raw}`;
}

async function removeSource(storagePath?: string) {
  if (!storagePath) return;
  const { supabaseUrl, serviceKey } = serverCredentials();
  await fetch(`${supabaseUrl}/storage/v1/object/audio/${encodedPath(storagePath)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey },
  }).catch(() => undefined);
}

function providerError(status: number, created: Record<string, unknown>) {
  const raw = String(created?.message || created?.error || JSON.stringify(created));
  if (/insufficient\s+credits?|credit\s+balance|not\s+enough\s+credits?/i.test(raw) || status === 402) {
    return new Error("Music.ai credits are exhausted. Add credits to the Music.ai workspace before running stem separation again.");
  }
  return new Error(`Music.ai create failed (${status}): ${raw}`);
}

async function startJob(req: Request, storagePath: string, stems: string[]) {
  const musicKey = Deno.env.get("MUSICAI_KEY");
  const workflow = Deno.env.get("MUSICAI_WORKFLOW");
  if (!musicKey || !workflow) throw new Error("Server missing MUSICAI_KEY or MUSICAI_WORKFLOW secret");
  const ipHash = await checkUsageLimit(req, stems.length);
  const inputUrl = await signedSourceUrl(storagePath);
  const params: Record<string, unknown> = { inputUrl };
  for (const stem of stems) params[stem] = true;
  const createRes = await fetch("https://api.music.ai/api/job", {
    method: "POST",
    headers: { "accept": "application/json", "Content-Type": "application/json", "Authorization": musicKey },
    body: JSON.stringify({ name: `MixForge corrective separation: ${stems.join(", ")}`, workflow, params }),
  });
  const created = await createRes.json().catch(() => ({}));
  if (!createRes.ok) throw providerError(createRes.status, created);
  if (!created.id) throw new Error("Music.ai did not return a job id");
  await recordUsage(ipHash, stems.length);
  return created.id as string;
}

function findOutput(result: Record<string, unknown>, stem: string): string | null {
  const direct = result?.[stem];
  if (typeof direct === "string") return direct;
  const variants = [stem, stem.replace(/s$/, ""), `${stem}Url`, `${stem}_url`];
  for (const key of variants) if (typeof result?.[key] === "string") return result[key] as string;
  for (const [key, value] of Object.entries(result || {})) {
    if (key.toLowerCase().includes(stem.replace(/s$/, "").toLowerCase()) && typeof value === "string") return value;
  }
  return null;
}

async function jobStatus(jobId: string, stems: string[]) {
  const musicKey = Deno.env.get("MUSICAI_KEY");
  if (!musicKey) throw new Error("Server missing MUSICAI_KEY secret");
  if (!/^[a-zA-Z0-9_-]{6,160}$/.test(jobId)) throw new Error("Invalid job id");
  const pollRes = await fetch(`https://api.music.ai/api/job/${encodeURIComponent(jobId)}`, {
    headers: { "accept": "application/json", "Authorization": musicKey },
  });
  const job = await pollRes.json().catch(() => ({}));
  if (!pollRes.ok) throw new Error(`Music.ai status failed (${pollRes.status}): ${job?.message || JSON.stringify(job)}`);
  const status = String(job.status || "PROCESSING").toUpperCase();
  if (status !== "SUCCEEDED") return { status, outputs: null, error: status === "FAILED" ? (job.error || "Music.ai job failed") : null };
  const result = job.result && typeof job.result === "object" ? job.result as Record<string, unknown> : {};
  const outputs: Record<string, string> = {};
  for (const stem of stems) {
    const url = findOutput(result, stem);
    if (url) outputs[stem] = url;
  }
  return { status, outputs, error: null };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return response(req, 405, { ok: false, error: "Method not allowed" });
  const origin = req.headers.get("origin") || "";
  if (!origin || !isAllowedOrigin(origin)) return response(req, 403, { ok: false, error: "Origin not allowed" });
  let storagePath = "";
  try {
    const body = await req.json();
    const action = body?.action === "status" ? "status" : "start";
    const stems = safeStems(body?.stems);
    if (!stems.length) throw new Error("At least one valid stem is required");
    storagePath = String(body?.storagePath || "");
    if (action === "start") {
      const jobId = await startJob(req, storagePath, stems);
      return response(req, 200, { ok: true, status: "QUEUED", jobId, stems });
    }
    const jobId = String(body?.jobId || "");
    const result = await jobStatus(jobId, stems);
    if (result.status === "SUCCEEDED" || result.status === "FAILED") await removeSource(storagePath);
    return response(req, 200, { ok: true, ...result });
  } catch (error) {
    if (storagePath) await removeSource(storagePath);
    console.error("MixForge separate-stem error", error);
    return response(req, 400, { ok: false, error: String(error?.message || error) });
  }
});