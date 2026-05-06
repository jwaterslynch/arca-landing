const crypto = require("crypto");

const POSTHOG_KEY = process.env.POSTHOG_PROJECT_API_KEY || "phc_zGHxudZJZL5bUoqfrjvfvcRuhZMrJGQncX3ikPGRePQt";
const POSTHOG_CAPTURE_HOST = (process.env.POSTHOG_CAPTURE_HOST || "https://us.i.posthog.com").replace(/\/$/, "");
const RELEASE_API_URL = "https://api.github.com/repos/jwaterslynch/arca-landing/releases/latest";
const FALLBACK_DOWNLOAD_URL = "https://github.com/jwaterslynch/arca-landing/releases/download/v0.1.0-beta.24/Arca_0.1.0-beta.24_aarch64.dmg";
const MAX_BODY_BYTES = 8 * 1024;

function isAllowedOrigin(origin) {
  if (!origin) return false;

  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "https:") return false;
    if (hostname === "witharca.app" || hostname === "www.witharca.app") return true;
    if (hostname.endsWith("-julian-waters-lynchs-projects.vercel.app")) return true;
    return false;
  } catch {
    return false;
  }
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

function sendJson(req, res, status, body) {
  setCors(req, res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  if (req.body && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }

  if (typeof req.body === "string") {
    try {
      return Promise.resolve(JSON.parse(req.body));
    } catch {
      return Promise.resolve(null);
    }
  }

  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = "";

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      raw += chunk;
    });

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });

    req.on("error", reject);
  });
}

function cleanString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function validEmail(value) {
  if (typeof value !== "string") return false;
  const email = value.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function emailHash(email) {
  return crypto.createHash("sha256").update(email.toLowerCase()).digest("hex");
}

function codeHmac(code) {
  const secret = process.env.ARCA_INVITE_HASH_SECRET || "";
  if (!secret) return "";
  return crypto
    .createHmac("sha256", secret)
    .update(code.trim().toLowerCase())
    .digest("hex");
}

function allowedCodeHashes() {
  return new Set(
    String(process.env.ARCA_INVITE_CODE_HASHES || "")
      .split(/[,\n]/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function timingSafeEquals(a, b) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function inviteCodeIsValid(code) {
  const candidate = codeHmac(code);
  if (!candidate) return false;

  for (const storedHash of allowedCodeHashes()) {
    if (timingSafeEquals(candidate, storedHash)) return true;
  }
  return false;
}

async function latestDmg() {
  const response = await fetch(RELEASE_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "witharca-download-gate",
    },
  });

  if (!response.ok) {
    throw new Error(`github_release_${response.status}`);
  }

  const release = await response.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const dmg =
    assets.find((asset) => /Arca_.*_aarch64\.dmg$/i.test(asset.name || "")) ||
    assets.find((asset) => /\.dmg$/i.test(asset.name || ""));

  if (!dmg || !dmg.browser_download_url) {
    throw new Error("github_release_missing_dmg");
  }

  return {
    name: dmg.name || "Arca.dmg",
    url: dmg.browser_download_url,
    version: release.tag_name || "",
  };
}

async function captureDownloadAccess(properties) {
  const hash = emailHash(properties.email);
  await fetch(`${POSTHOG_CAPTURE_HOST}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: POSTHOG_KEY,
      event: "arca_invite_download_unlocked",
      distinct_id: `email:${hash.slice(0, 32)}`,
      properties: {
        ...properties,
        email_hash: hash,
        $process_person_profile: false,
      },
    }),
  }).catch(() => {});
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(req, res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  if (!isAllowedOrigin(req.headers.origin)) {
    sendJson(req, res, 403, { ok: false, error: "Origin not allowed" });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(req, res, 413, { ok: false, error: "Submission is too large" });
    return;
  }

  if (!body || typeof body !== "object") {
    sendJson(req, res, 400, { ok: false, error: "Invalid submission" });
    return;
  }

  if (cleanString(body.website || "", 200)) {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  const email = cleanString(body.email, 254).toLowerCase();
  const inviteCode = cleanString(body.invite_code, 120);

  if (!validEmail(email)) {
    sendJson(req, res, 400, { ok: false, error: "Enter a valid email address" });
    return;
  }

  if (!inviteCode) {
    sendJson(req, res, 400, { ok: false, error: "Enter your invite code" });
    return;
  }

  if (!inviteCodeIsValid(inviteCode)) {
    sendJson(req, res, 403, { ok: false, error: "That invite code did not work" });
    return;
  }

  let download;
  try {
    download = await latestDmg();
  } catch {
    download = {
      name: "Arca_0.1.0-beta.24_aarch64.dmg",
      url: FALLBACK_DOWNLOAD_URL,
      version: "v0.1.0-beta.24",
    };
  }

  await captureDownloadAccess({
    product: "arca",
    access_type: "Private alpha download",
    email,
    invite_code_hash: codeHmac(inviteCode),
    download_name: download.name,
    download_version: download.version,
    source_url: cleanString(body.source_url, 500),
    page_path: cleanString(body.page_path, 240),
    user_agent: cleanString(req.headers["user-agent"], 300),
    unlocked_at: new Date().toISOString(),
  });

  sendJson(req, res, 200, {
    ok: true,
    download_url: download.url,
    download_name: download.name,
    download_version: download.version,
  });
};
