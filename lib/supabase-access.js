const SUPABASE_URL = (process.env.ARCA_SUPABASE_URL || "https://fncixgbeiqtschzdvhgk.supabase.co").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.ARCA_SUPABASE_SERVICE_ROLE_KEY || "";

function configured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function compactObject(input) {
  return Object.fromEntries(
    Object.entries(input || {}).filter(([, value]) => value !== undefined)
  );
}

async function rest(path, options = {}) {
  if (!configured()) {
    return { skipped: true, data: null };
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`supabase_${response.status}_${detail}`);
  }

  return { skipped: false, data };
}

async function upsertProductMembership(input) {
  const row = compactObject({
    product: input.product,
    email: input.email,
    tier: input.tier || "alpha",
    role: input.role || "tester",
    status: input.status || "active",
    source: input.source || "invite_code",
    invite_code_hash: input.inviteCodeHash,
    metadata: input.metadata || {},
  });

  const result = await rest("product_memberships?on_conflict=product,email", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: row,
  });

  return Array.isArray(result.data) ? result.data[0] : result.data;
}

async function insertDownloadEvent(input) {
  const row = compactObject({
    product: input.product,
    email: input.email,
    membership_id: input.membershipId,
    invite_code_hash: input.inviteCodeHash,
    artifact_name: input.artifactName,
    artifact_version: input.artifactVersion,
    source_url: input.sourceUrl,
    page_path: input.pagePath,
    user_agent: input.userAgent,
    metadata: input.metadata || {},
  });

  await rest("product_download_events", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: row,
  });
}

async function insertAccessRequest(input) {
  const row = compactObject({
    product: input.product,
    email: input.email,
    name: input.name,
    organization: input.organization,
    message: input.message,
    access_type: input.accessType,
    source_url: input.sourceUrl,
    page_path: input.pagePath,
    user_agent: input.userAgent,
    metadata: input.metadata || {},
  });

  await rest("product_access_requests", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: row,
  });
}

module.exports = {
  configured,
  insertAccessRequest,
  insertDownloadEvent,
  upsertProductMembership,
};
