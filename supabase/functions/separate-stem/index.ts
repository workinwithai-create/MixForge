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

function absoluteStorageUrl(supabaseUrl: string, raw: unknown) {
  const value = String(raw || "");
  if (!value) throw new Error("Storage did not return a signed URL");
  if (value.startsWith("http")) return value;
  if (value.startsWith("/storage/v1")) return `${supabaseUrl}${value}`;
  return `${supabaseUrl}/storage/v1${value.startsWith("/") ? "" : "/"}${value}`;
}

function serverCredentials() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase service credentials are unavailable");
  return { supabaseUrl, serviceKey };
}

function runpodCredentials() {
  const endpointId = Deno.env.get("RUNPOD_ENDPOINT_ID");
  const apiKey = Deno.env.get("RUNPOD_API_KEY");
  if (!endpointId || !apiKey) throw new Error("Low-cost RunPod separator is not configured yet.");
  return { endpointId, apiKey };
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

type SignOptions = { retries?: number; label?: string };

async function signedDownloadUrl(storagePath: string, expiresIn = 3600, options: SignOptions = {}) {
  const { supabaseUrl, serviceKey } = serverCredentials();
  const retries = Math.max(0, Math.min(8, options.retries || 0));
  const label = options.label || "audio object";
  let lastStatus = 0;
  let lastMessage = "Object not found";

  for (let attempt = 0; attempt <= retries; attempt++) {
    const signRes = await fetch(`${supabaseUrl}/storage/v1/object/sign/audio/${encodedPath(storagePath)}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn }),
    });
    const signed = await signRes.json().catch(() => ({}));
    if (signRes.ok) return absoluteStorageUrl(supabaseUrl, signed.signedURL || signed.signedUrl || signed.url);

    lastStatus = signRes.status;
    lastMessage = String(signed?.message || signed?.error || JSON.stringify(signed));
    const visibilityDelay = signRes.status === 400 && /object\s+not\s+found/i.test(lastMessage);
    if (!visibilityDelay || attempt === retries) break;
    const delay = Math.min(4000, 400 * (2 ** attempt));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error(`Could not sign ${label} (${lastStatus}): ${lastMessage}`);
}

async function signedUploadUrl(storagePath: string) {
  const { supabaseUrl, serviceKey } = serverCredentials();
  const signRes = await fetch(`${supabaseUrl}/storage/v1/object/upload/sign/audio/${encodedPath(storagePath)}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey, "Content-Type": "application/json", "x-upsert": "true" },
    body: JSON.stringify({}),
  });
  const signed = await signRes.json().catch(() => ({}));
  if (!signRes.ok) throw new Error(`Could not create stem upload URL (${signRes.status}): ${signed?.message || JSON.stringify(signed)}`);
  return absoluteStorageUrl(supabaseUrl, signed.signedURL || signed.signedUrl || signed.url);
}

async function removePaths(paths: string[]) {
  if (!paths.length) return;
  const { supabaseUrl, serviceKey } = serverCredentials();
  await fetch(`${supabaseUrl}/storage/v1/object/audio`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey, "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: paths }),
  }).catch(() => undefined);
}

async function startRunPodJob(req: Request, storagePath: string, stems: string[]) {
  if (!/^uploads\/[a-zA-Z0-9._/-]+$/.test(storagePath) || storagePath.includes("..")) throw new Error("Invalid storage path");
  const { endpointId, apiKey } = runpodCredentials();
  const ipHash = await checkUsageLimit(req, stems.length);
  const inputUrl = await signedDownloadUrl(storagePath, 3600, { retries: 7, label: "uploaded source" });
  const jobToken = crypto.randomUUID();
  const outputPaths: Record<string, string> = {};
  const uploadUrls: Record<string, string> = {};
  for (const stem of stems) {
    const path = `separated/${jobToken}/${stem}.wav`;
    outputPaths[stem] = path;
    uploadUrls[stem] = await signedUploadUrl(path);
  }

  const runRes = await fetch(`https://api.runpod.ai/v2/${encodeURIComponent(endpointId)}/run`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { inputUrl, stems, uploadUrls } }),
  });
  const run = await runRes.json().catch(() => ({}));
  if (!runRes.ok || !run.id) {
    await removePaths(Object.values(outputPaths));
    throw new Error(`RunPod start failed (${runRes.status}): ${run?.error || run?.message || JSON.stringify(run)}`);
  }
  await recordUsage(ipHash, stems.length);
  return { jobId: String(run.id), outputPaths };
}

async function runPodStatus(jobId: string, stems: string[], outputPaths: Record<string, string>) {
  const { endpointId, apiKey } = runpodCredentials();
  if (!/^[a-zA-Z0-9_-]{6,200}$/.test(jobId)) throw new Error("Invalid RunPod job id");
  const statusRes = await fetch(`https://api.runpod.ai/v2/${encodeURIComponent(endpointId)}/status/${encodeURIComponent(jobId)}`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  const job = await statusRes.json().catch(() => ({}));
  if (!statusRes.ok) throw new Error(`RunPod status failed (${statusRes.status}): ${job?.error || job?.message || JSON.stringify(job)}`);
  const rawStatus = String(job.status || "IN_QUEUE").toUpperCase();
  if (["IN_QUEUE", "IN_PROGRESS"].includes(rawStatus)) return { status: rawStatus, outputs: null, error: null };
  if (rawStatus === "FAILED" || rawStatus === "CANCELLED" || job?.output?.error) {
    await removePaths(Object.values(outputPaths));
    return { status: "FAILED", outputs: null, error: String(job?.output?.error || job?.error || `RunPod job ${rawStatus.toLowerCase()}`) };
  }
  if (rawStatus !== "COMPLETED") return { status: rawStatus, outputs: null, error: null };

  const outputs: Record<string, string> = {};
  for (const stem of stems) {
    const path = outputPaths[stem];
    if (!path) throw new Error(`Missing output path for returned ${stem} stem`);
    outputs[stem] = await signedDownloadUrl(path, 3600, { retries: 7, label: `returned ${stem} stem` });
  }
  return { status: "SUCCEEDED", outputs, error: null };
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
      const started = await startRunPodJob(req, storagePath, stems);
      return response(req, 200, { ok: true, status: "QUEUED", jobId: started.jobId, stems, outputPaths: started.outputPaths });
    }
    const jobId = String(body?.jobId || "");
    const outputPaths = body?.outputPaths && typeof body.outputPaths === "object" ? body.outputPaths as Record<string, string> : {};
    const result = await runPodStatus(jobId, stems, outputPaths);
    if (result.status === "SUCCEEDED" || result.status === "FAILED") await removePaths(storagePath ? [storagePath] : []);
    return response(req, 200, { ok: true, ...result, outputPaths });
  } catch (error) {
    if (storagePath) await removePaths([storagePath]);
    console.error("MixForge separate-stem error", error);
    return response(req, 400, { ok: false, error: String(error?.message || error) });
  }
});