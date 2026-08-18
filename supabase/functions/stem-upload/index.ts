import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "audio";
const MAX_BYTES = 180 * 1024 * 1024;
const PATH_PATTERN = /^separated\/[0-9a-f-]{36}\/(vocals|bass|drums|other)\.wav$/i;

function serverCredentials() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("Storage bridge credentials are unavailable");
  return { supabaseUrl, serviceKey };
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function verifyToken(token: string) {
  const [payloadPart, signaturePart, extra] = token.split(".");
  if (!payloadPart || !signaturePart || extra) throw new Error("Malformed upload token");
  const { serviceKey } = serverCredentials();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(serviceKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlDecode(signaturePart),
    new TextEncoder().encode(payloadPart),
  );
  if (!verified) throw new Error("Invalid upload token");
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)));
  const path = String(payload?.path || "");
  const expiresAt = Number(payload?.exp || 0);
  if (!PATH_PATTERN.test(path) || path.includes("..")) throw new Error("Invalid stem destination");
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) throw new Error("Upload token expired");
  if (expiresAt > Math.floor(Date.now() / 1000) + 3 * 60 * 60) throw new Error("Upload token lifetime is invalid");
  return path;
}

async function extractFile(req: Request): Promise<{ file: Blob; contentType: string }> {
  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (declaredLength > MAX_BYTES) throw new Error("Stem file exceeds the 180 MB upload limit");
  const incomingType = req.headers.get("content-type") || "audio/wav";

  let file: Blob | null = null;
  if (/multipart\/form-data/i.test(incomingType)) {
    const form = await req.formData();
    for (const value of form.values()) {
      if (value instanceof Blob) {
        file = value;
        break;
      }
    }
    if (!file) throw new Error("Multipart upload did not contain a file");
  } else {
    file = await req.blob();
  }

  if (file.size <= 44) throw new Error("Uploaded stem was empty");
  if (file.size > MAX_BYTES) throw new Error("Stem file exceeds the 180 MB upload limit");
  const contentType = file.type && file.type !== "application/octet-stream"
    ? file.type
    : (/audio\//i.test(incomingType) ? incomingType : "audio/wav");
  return { file, contentType };
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (!["PUT", "POST"].includes(req.method)) return json(405, { ok: false, error: "Method not allowed" });
  try {
    const url = new URL(req.url);
    const path = await verifyToken(url.searchParams.get("token") || "");
    const { supabaseUrl, serviceKey } = serverCredentials();
    const { file, contentType } = await extractFile(req);
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await admin.storage.from(BUCKET).upload(path, file, {
      contentType,
      cacheControl: "0",
      upsert: true,
    });
    if (error) {
      console.error("MixForge official storage upload rejection", {
        statusCode: error.statusCode,
        name: error.name,
        message: error.message,
        path,
        bytes: file.size,
        contentType,
      });
      return json(Number(error.statusCode) || 400, {
        ok: false,
        error: error.message || "Private stem storage rejected the upload",
        code: error.name || "StorageError",
      });
    }
    return json(200, { ok: true, path: data.path, bytes: file.size, contentType });
  } catch (error) {
    console.error("MixForge stem upload bridge error", error);
    const message = String(error?.message || error);
    const status = /token|destination|expired/i.test(message) ? 403 : 400;
    return json(status, { ok: false, error: message });
  }
});
