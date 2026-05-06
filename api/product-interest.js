const crypto = require("crypto");

const POSTHOG_KEY = process.env.POSTHOG_PROJECT_API_KEY || "phc_zGHxudZJZL5bUoqfrjvfvcRuhZMrJGQncX3ikPGRePQt";
const POSTHOG_CAPTURE_HOST = (process.env.POSTHOG_CAPTURE_HOST || "https://us.i.posthog.com").replace(/\/$/, "");
const MAX_BODY_BYTES = 16 * 1024;
const PRODUCT_LABELS = {
  arca: "Arca",
  jia: "JIA",
  fieldwork: "Fieldwork",
  "founder-compact": "Founder Compact",
  diwan: "Diwan",
  general: "General product interest",
};
const PRODUCT_AUDIENCE_KEYS = {
  arca: "arca-alpha-circle",
  jia: "jia-demo-access",
  fieldwork: "fieldwork-beta",
  "founder-compact": "founder-compact-pilots",
  diwan: "diwan-course-interest",
  general: "product-interest-general",
};

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

function valueHash(value) {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

async function captureProductInterest(properties) {
  const hash = emailHash(properties.email);
  const response = await fetch(`${POSTHOG_CAPTURE_HOST}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: POSTHOG_KEY,
      event: "product_interest_submit",
      distinct_id: `email:${hash.slice(0, 32)}`,
      properties: {
        ...properties,
        email_hash: hash,
        $process_person_profile: false,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`posthog_capture_failed_${response.status}`);
  }
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
  } catch (error) {
    sendJson(req, res, 413, { ok: false, error: "Submission is too large" });
    return;
  }

  if (!body || typeof body !== "object") {
    sendJson(req, res, 400, { ok: false, error: "Invalid submission" });
    return;
  }

  if (cleanString(body.website || body.company_url || "", 200)) {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  const product = cleanString(body.product, 48).toLowerCase();
  if (!PRODUCT_LABELS[product]) {
    sendJson(req, res, 400, { ok: false, error: "Unknown product" });
    return;
  }

  const email = cleanString(body.email, 254).toLowerCase();
  if (!validEmail(email)) {
    sendJson(req, res, 400, { ok: false, error: "Enter a valid email address" });
    return;
  }

  if (body.consent !== true) {
    sendJson(req, res, 400, { ok: false, error: "Consent is required" });
    return;
  }

  const inviteCode = cleanString(body.invite_code, 120);
  const properties = {
    product,
    product_label: PRODUCT_LABELS[product],
    audience_key: PRODUCT_AUDIENCE_KEYS[product],
    access_type: cleanString(body.access_type, 80) || "interest",
    email,
    name: cleanString(body.name, 120),
    organization: cleanString(body.organization, 160),
    invite_code_present: Boolean(inviteCode),
    invite_code_hash: inviteCode ? valueHash(inviteCode) : "",
    message: cleanString(body.message, 1200),
    page_path: cleanString(body.page_path, 240),
    source_url: cleanString(body.source_url, 500),
    user_agent: cleanString(req.headers["user-agent"], 300),
    submitted_at: new Date().toISOString(),
  };

  try {
    await captureProductInterest(properties);
    sendJson(req, res, 200, { ok: true });
  } catch (error) {
    console.error("product_interest_submit failed", error);
    sendJson(req, res, 502, { ok: false, error: "Could not save submission" });
  }
};
