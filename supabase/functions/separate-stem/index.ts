const DEMUCS_STEMS = new Set(["vocals", "bass", "drums", "other"]);
const STEM_ALIASES: Record<string, string> = { guitars: "other", keys: "other" };
const SUPPORTED_ENGINES = new Set(["demucs", "melband", "auto"]);
const SUPPORTED_MODES = new Set(["fast", "quality", "forensic", "hq"]);
const ALLOWED_ORIGINS = [
  /^https:\/\/mix\.workinwithai\.com$/,
  /^https:\/\/mixforge\.workinwithai\.com$/,
  /^https:\/\/mix-forge(?:-[a-z0-9-]+)?\.vercel\.app$/,
  /^https:\/\/[a-z0-9-]+-release-forge\.vercel\.app$/,
  /^http:\/\/localhost(?::\d+)?$/,
];
const HOURLY_STEM_LIMIT = 12;
const DAILY_STEM_LIMIT = 30;

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.some((pattern) => pattern.test(origin));
}

function cors(req) {
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

function response(req, status, body) {
  return new Response(JSON.stringify(body), { status, headers: cors(req) });
}

function safeStems(value: unknown) {
  if (!Array.isArray(value)) return [];
  const stems: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const actual = STEM_ALIASES[raw] || raw;
    if (!DEMUCS_STEMS.has(actual) || stems.includes(actual)) continue;
    stems.push(actual);
  }
  return stems.slice(0, 4);
}

function safeEngine(value: unknown) {
  const engine = String(value || "demucs").toLowerCase();
  return SUPPORTED_ENGINES.has(engine) ? engine : "demucs";
}

function safeMode(value: unknown) {
  const mode = String(value || "fast").toLowerCase();
  return SUPPORTED_MODES.has(mode) ? mode : "fast";
}

function encodedPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function absoluteStorageUrl(supabaseUrl, raw) {
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

async function clientHash(req) {
  const { serviceKey } = serverCredentials();
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
  const bytes = new TextEncoder().encode(`${address}:${serviceKey.slice(-24)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkUsageLimit(req, requestedStemCount) {
  const { supabaseUrl, serviceKey } = serverCredentials();
  const ipHash = await clientHash(req);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const query = new URL(`${supabaseUrl}/rest/v1/mixforge_stem_usage`);
  query.searchParams.set("select", "stem_count,created_at");
  query.searchParams.set("ip_hash", `eq.${ipHash}`);
  query.searchParams.set("created_at", `gte.${since}`);
  const usageRes = await fetch(query, {
    headers: { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey },
  });
  const usage = await usageRes.json().catch(() => []);
  if (!usageRes.ok || !Array.isArray(usage)) throw new Error("Could not verify separation usage limits");
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const daily = usage.reduce((sum, row) => sum + Number(row.stem_count || 0), 0);
  const hourly = usage
    .filter((row) => new Date(row.created_at).getTime() >= hourAgo)
    .reduce((sum, row) => sum + Number(row.stem_count || 0), 0);
  if (hourly + requestedStemCount > HOURLY_STEM_LIMIT) throw new Error("Hourly stem-separation limit reached. Try again later.");
  if (daily + requestedStemCount > DAILY_STEM_LIMIT) throw new Error("Daily stem-separation limit reached. Try again tomorrow.");
}

async function recordSuccessfulUsage(jobId, ipHash, requestedStemCount) {
  const { supabaseUrl, serviceKey } = serverCredentials();
  const query = new URL(`${supabaseUrl}/rest/v1/mixforge_stem_usage`);
  query.searchParams.set("on_conflict", "job_id");
  const insertRes = await fetch(query, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${serviceKey}`,
      "apikey": serviceKey,
      "Content-Type": "application/json",
      "Prefer": "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify({ job_id: jobId, ip_hash: ipHash, stem_count: requestedStemCount }),
  });
  if (!insertRes.ok) console.warn("Could not record successful separation usage", insertRes.status);
}

async function signedDownloadUrl(storagePath, expiresIn = 3600, options = {}) {
  const { supabaseUrl, serviceKey } = serverCredentials();
  const retries = Math.max(0, Math.min(8, Number(options.retries || 0)));
  const label = options.label || "audio object";
  let lastStatus = 0;
  let lastMessage = "Object not found";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const signRes = await fetch(`${supabaseUrl}/storage/v1/object/sign/audio/${encodedPath(storagePath)}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serviceKey}`,
        "apikey": serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn }),
    });
    const signed = await signRes.json().catch(() => ({}));
    if (signRes.ok) return absoluteStorageUrl(supabaseUrl, signed.signedURL || signed.signedUrl || signed.url);
    lastStatus = signRes.status;
    lastMessage = String(signed?.message || signed?.error || JSON.stringify(signed));
    const visibilityDelay = signRes.status === 400 && /object\s+not\s+found/i.test(lastMessage);
    if (!visibilityDelay || attempt === retries) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 400 * (2 ** attempt))));
  }
  throw new Error(`Could not sign ${label} (${lastStatus}): ${lastMessage}`);
}

async function signedUploadUrl(storagePath) {
  const { supabaseUrl, serviceKey } = serverCredentials();
  const signRes = await fetch(`${supabaseUrl}/storage/v1/object/upload/sign/audio/${encodedPath(storagePath)}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${serviceKey}`,
      "apikey": serviceKey,
      "Content-Type": "application/json",
      "x-upsert": "true",
    },
    body: JSON.stringify({}),
  });
  const signed = await signRes.json().catch(() => ({}));
  if (!signRes.ok) {
    throw new Error(`Could not create stem upload URL (${signRes.status}): ${signed?.message || signed?.error || JSON.stringify(signed)}`);
  }
  return absoluteStorageUrl(supabaseUrl, signed.signedURL || signed.signedUrl || signed.url);
}

async function removePaths(paths) {
  if (!paths.length) return;
  const { supabaseUrl, serviceKey } = serverCredentials();
  await fetch(`${supabaseUrl}/storage/v1/object/audio`, {
    method: "DELETE",
    headers: {
      "Authorization": `Bearer ${serviceKey}`,
      "apikey": serviceKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefixes: paths }),
  }).catch(() => undefined);
}

async function startRunPodJob(req, storagePath, stems, engine, mode) {
  if (!/^uploads\/[a-zA-Z0-9._/-]+$/.test(storagePath) || storagePath.includes("..")) {
    throw new Error("Invalid storage path");
  }
  const { endpointId, apiKey } = runpodCredentials();
  await checkUsageLimit(req, stems.length);
  const inputUrl = await signedDownloadUrl(storagePath, 3600, { retries: 7, label: "uploaded source" });
  const jobToken = crypto.randomUUID();
  const outputPaths = {};
  const uploadUrls = {};
  for (const stem of stems) {
    const path = `separated/${jobToken}/${stem}.wav`;
    outputPaths[stem] = path;
    uploadUrls[stem] = await signedUploadUrl(path);
  }
  const runRes = await fetch(`https://api.runpod.ai/v2/${encodeURIComponent(endpointId)}/run`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { inputUrl, stems, uploadUrls, engine, mode } }),
  });
  const run = await runRes.json().catch(() => ({}));
  if (!runRes.ok || !run.id) {
    await removePaths(Object.values(outputPaths));
    throw new Error(`RunPod start failed (${runRes.status}): ${run?.error || run?.message || JSON.stringify(run)}`);
  }
  return { jobId: String(run.id), outputPaths, engine, mode };
}

async function runPodStatus(req, jobId, stems, outputPaths) {
  const { endpointId, apiKey } = runpodCredentials();
  if (!/^[a-zA-Z0-9_-]{6,200}$/.test(jobId)) throw new Error("Invalid RunPod job id");
  const statusRes = await fetch(`https://api.runpod.ai/v2/${encodeURIComponent(endpointId)}/status/${encodeURIComponent(jobId)}`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  const job = await statusRes.json().catch(() => ({}));
  if (!statusRes.ok) throw new Error(`RunPod status failed (${statusRes.status}): ${job?.error || job?.message || JSON.stringify(job)}`);
  const rawStatus = String(job.status || "IN_QUEUE").toUpperCase();
  if (["IN_QUEUE", "IN_PROGRESS"].includes(rawStatus)) return { status: rawStatus, outputs: null, error: null, separator: null };
  if (rawStatus === "FAILED" || rawStatus === "CANCELLED" || job?.output?.error) {
    await removePaths(Object.values(outputPaths));
    const rawError = String(job?.output?.error || job?.error || `RunPod job ${rawStatus.toLowerCase()}`);
    let helpfulError = rawError;
    if (/functions\/v1\/stem-upload/i.test(rawError)) {
      helpfulError = "This job used the retired upload bridge. Start a fresh source investigation.";
    } else if (/storage\/v1\/object\/upload\/sign/i.test(rawError) && /400 Client Error/i.test(rawError)) {
      helpfulError = "The separated WAV exceeded the current Supabase Storage file-size setting. Raise the MixForge project's Global file size limit to 200 MB, then start a fresh source investigation.";
    }
    return { status: "FAILED", outputs: null, error: helpfulError, separator: job?.output?.separator || null };
  }
  if (rawStatus !== "COMPLETED") return { status: rawStatus, outputs: null, error: null, separator: null };
  const outputs = {};
  for (const stem of stems) {
    const path = outputPaths[stem];
    if (!path) throw new Error(`Missing output path for returned ${stem} stem`);
    outputs[stem] = await signedDownloadUrl(path, 3600, { retries: 7, label: `returned ${stem} stem` });
  }
  await recordSuccessfulUsage(jobId, await clientHash(req), stems.length);
  return { status: "SUCCEEDED", outputs, error: null, separator: job?.output?.separator || null };
}

Deno.serve(async (req) => {
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
      const engine = safeEngine(body?.engine);
      const mode = safeMode(body?.mode);
      const started = await startRunPodJob(req, storagePath, stems, engine, mode);
      return response(req, 200, {
        ok: true,
        status: "QUEUED",
        jobId: started.jobId,
        stems,
        outputPaths: started.outputPaths,
        requestedEngine: started.engine,
        mode: started.mode,
      });
    }
    const jobId = String(body?.jobId || "");
    const outputPaths = body?.outputPaths && typeof body.outputPaths === "object" ? body.outputPaths : {};
    const result = await runPodStatus(req, jobId, stems, outputPaths);
    if (result.status === "SUCCEEDED" || result.status === "FAILED") {
      await removePaths(storagePath ? [storagePath] : []);
    }
    return response(req, 200, { ok: true, ...result, outputPaths });
  } catch (error) {
    if (storagePath) await removePaths([storagePath]);
    console.error("MixForge separate-stem error", error);
    return response(req, 400, { ok: false, error: String(error?.message || error) });
  }
});
