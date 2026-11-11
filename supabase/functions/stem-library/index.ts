// Older MixForge stems: the separations made before the shared song library existed.
// They were saved by date only (separated/<job>/<stem>.wav) with no song name or owner, so only
// WorkinWithAI founder accounts may list them. Each can be played here or added to the song library.
// It never writes or deletes anything in MixForge's own storage. Its one write is "copy": it streams
// an older stem straight into the member's shared song library, using a one-time upload ticket the
// WorkinWithAI Hub issued for that member's own song, so the file never has to pass through the browser.
const BUCKET = "audio";
const HUB_ENTITLEMENTS_URL = "https://workinwithai.com/api/entitlements/me";
const MIX_ORIGIN = "https://mixforge.workinwithai.com";
const FOUNDER_EMAILS = new Set(["workinwithai@gmail.com", "markparsonsjrmusic@gmail.com", "mpjrecords90@gmail.com"]);
const ALLOWED_ORIGINS = [
  /^https:\/\/mix\.workinwithai\.com$/,
  /^https:\/\/mixforge\.workinwithai\.com$/,
  /^https:\/\/mix-forge(?:-[a-z0-9-]+)?\.vercel\.app$/,
  /^http:\/\/localhost(?::\d+)?$/,
];
const STEM_PATH = /^separated\/[0-9a-f-]{36}\/(vocals|bass|drums|other)\.wav$/i;
const UPLOAD_PATH = /^uploads\/[0-9a-f-]{36}-[A-Za-z0-9._-]{1,140}\.wav$/;
const SIGN_SECONDS = 60 * 60;
const LIBRARY_HOST = "kldstbhnpwpvvubphnas.supabase.co";
const LIBRARY_UPLOAD_PREFIX = "/storage/v1/object/upload/sign/song-library/";
const MAX_COPY_BYTES = 300 * 1024 * 1024;
const LIST_CONCURRENCY = 8;

function isAllowedOrigin(origin: string) {
  return ALLOWED_ORIGINS.some((pattern) => pattern.test(origin));
}

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin) ? origin : MIX_ORIGIN,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-wwa-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
}

function response(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: cors(req) });
}

function isFounder(email: unknown) {
  const value = String(email || "").trim().toLowerCase();
  return FOUNDER_EMAILS.has(value) || value.endsWith("@workinwithai.com");
}

async function verifyFounder(req: Request) {
  const token = req.headers.get("x-wwa-token")?.trim() || "";
  if (!token) return { ok: false, status: 401, reason: "login" };
  try {
    const res = await fetch(HUB_ENTITLEMENTS_URL, {
      headers: { "Authorization": `Bearer ${token}`, "Origin": MIX_ORIGIN, "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: 503, reason: "unavailable" };
    if (!data?.signedIn) return { ok: false, status: 401, reason: "login" };
    if (!isFounder(data?.email)) return { ok: false, status: 403, reason: "founder-only" };
    return { ok: true, status: 200, reason: "ok" };
  } catch (error) {
    console.error("stem-library access check failed", error);
    return { ok: false, status: 503, reason: "unavailable" };
  }
}

function serverCredentials() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("Storage credentials are unavailable");
  return { supabaseUrl, serviceKey };
}

type ListedObject = { name: string; id: string | null; created_at?: string; metadata?: { size?: number } | null };

async function listFolder(prefix: string): Promise<ListedObject[]> {
  const { supabaseUrl, serviceKey } = serverCredentials();
  const out: ListedObject[] = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const res = await fetch(`${supabaseUrl}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
    });
    const page = await res.json().catch(() => []);
    if (!res.ok || !Array.isArray(page)) throw new Error(`Could not list ${prefix} (${res.status})`);
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function uploadTitle(name: string) {
  return name.replace(/^[0-9a-f-]{36}-/i, "").replace(/-separation(-proxy)?\.wav$/i, "").replace(/\.wav$/i, "").replace(/_+/g, " ").trim() || "Upload";
}

async function listOlder() {
  const folders = (await listFolder("separated/")).filter((item) => item.id === null && /^[0-9a-f-]{36}$/i.test(item.name));
  const sets = await mapLimit(folders, LIST_CONCURRENCY, async (folder) => {
    const files = (await listFolder(`separated/${folder.name}/`))
      .filter((f) => f.id !== null && /^(vocals|bass|drums|other)\.wav$/i.test(f.name))
      .map((f) => ({
        path: `separated/${folder.name}/${f.name}`,
        stem: f.name.replace(/\.wav$/i, "").toLowerCase(),
        size: Number(f.metadata?.size || 0),
        createdAt: f.created_at || null,
      }));
    const createdAt = files.map((f) => f.createdAt).filter(Boolean).sort()[0] || null;
    return { id: folder.name, createdAt, stems: files };
  });
  const uploads = (await listFolder("uploads/"))
    .filter((f) => f.id !== null && UPLOAD_PATH.test(`uploads/${f.name}`))
    .map((f) => ({ path: `uploads/${f.name}`, title: uploadTitle(f.name), size: Number(f.metadata?.size || 0), createdAt: f.created_at || null }));
  return {
    stemSets: sets.filter((s) => s.stems.length).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    uploads: uploads.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
  };
}

async function signedUrl(path: string, download?: string) {
  const { supabaseUrl, serviceKey } = serverCredentials();
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${supabaseUrl}/storage/v1/object/sign/${BUCKET}/${encoded}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: SIGN_SECONDS }),
  });
  const signed = await res.json().catch(() => ({}));
  const raw = String(signed.signedURL || signed.signedUrl || "");
  if (!res.ok || !raw) throw new Error(`Could not sign that file (${res.status})`);
  const url = raw.startsWith("http") ? raw : `${supabaseUrl}/storage/v1${raw.startsWith("/") ? "" : "/"}${raw}`;
  return download ? `${url}&download=${encodeURIComponent(download)}` : url;
}

// Only a Hub-issued upload ticket for the shared song library is accepted as a destination.
function libraryUploadUrl(raw: unknown): URL | null {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "https:" || url.hostname !== LIBRARY_HOST || url.port) return null;
    if (!url.pathname.startsWith(LIBRARY_UPLOAD_PREFIX) || url.pathname.includes("..")) return null;
    if (!url.searchParams.get("token")) return null;
    return url;
  } catch {
    return null;
  }
}

async function copyToLibrary(path: string, uploadUrl: URL) {
  const { supabaseUrl, serviceKey } = serverCredentials();
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const source = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${encoded}`, {
    headers: { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey },
  });
  if (!source.ok) throw new Error(`Could not read that stem (${source.status})`);
  const bytes = new Uint8Array(await source.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_COPY_BYTES) throw new Error("That stem is empty or larger than 300 MB");
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "audio/wav", "x-upsert": "false" },
    body: bytes,
  });
  if (!put.ok) {
    const detail = (await put.text().catch(() => "")).slice(0, 200);
    throw new Error(`The song library refused the copy (${put.status}) ${detail}`.trim());
  }
  return bytes.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return response(req, 405, { ok: false, error: "Method not allowed" });
  const origin = req.headers.get("origin") || "";
  if (!origin || !isAllowedOrigin(origin)) return response(req, 403, { ok: false, error: "Origin not allowed" });
  const access = await verifyFounder(req);
  if (!access.ok) return response(req, access.status, { ok: false, reason: access.reason, error: "Older stems are only open to the WorkinWithAI founder account." });

  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action === "list") return response(req, 200, { ok: true, ...(await listOlder()) });
    if (body?.action === "sign") {
      const path = String(body?.path || "");
      if (path.includes("..") || !(STEM_PATH.test(path) || UPLOAD_PATH.test(path))) {
        return response(req, 400, { ok: false, error: "Bad path" });
      }
      const fileName = String(body?.downloadName || path.split("/").pop() || "stem.wav").replace(/[^A-Za-z0-9 ._()-]+/g, " ").trim().slice(0, 120) || "stem.wav";
      const [playUrl, downloadUrl] = await Promise.all([signedUrl(path), signedUrl(path, fileName)]);
      return response(req, 200, { ok: true, playUrl, downloadUrl, expiresInSec: SIGN_SECONDS });
    }
    if (body?.action === "copy") {
      const path = String(body?.path || "");
      if (path.includes("..") || !(STEM_PATH.test(path) || UPLOAD_PATH.test(path))) {
        return response(req, 400, { ok: false, error: "Bad path" });
      }
      const uploadUrl = libraryUploadUrl(body?.uploadUrl);
      if (!uploadUrl) return response(req, 400, { ok: false, error: "Bad upload ticket" });
      const size = await copyToLibrary(path, uploadUrl);
      return response(req, 200, { ok: true, size });
    }
    return response(req, 400, { ok: false, error: "Unknown action" });
  } catch (error) {
    console.error("stem-library error", error);
    return response(req, 500, { ok: false, error: String((error as Error)?.message || "Older stems are unavailable right now.").slice(0, 300) });
  }
});
