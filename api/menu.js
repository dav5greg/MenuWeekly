const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Expected-SHA",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS"
};

function githubHeaders() {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "MenuWeekly-Vercel-API"
  };
}

function githubFileUrl() {
  const repo = process.env.GITHUB_REPOSITORY;
  const path = process.env.GITHUB_FILE_PATH || "data/menu.json";
  return `https://api.github.com/repos/${repo}/contents/${path}`;
}

async function getGitHubFile() {
  const response = await fetch(githubFileUrl(), { headers: githubHeaders(), cache: "no-store" });
  if (!response.ok) throw new Error(`GitHub GET failed (${response.status}): ${await response.text()}`);
  const file = await response.json();
  const data = JSON.parse(Buffer.from(file.content.replace(/\\n/g, ""), "base64").toString("utf8"));
  return { data, sha: file.sha };
}

function validData(data) {
  if (!data || !Array.isArray(data.dishes) || !data.weeks || typeof data.weeks !== "object") return false;
  if (!data.settings || typeof data.settings.showWeekend !== "boolean") return false;
  return data.dishes.every(d => d && typeof d.id === "string" && typeof d.title === "string");
}

async function putGitHubFile(data, expectedSha) {
  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8").toString("base64");
  const response = await fetch(githubFileUrl(), {
    method: "PUT",
    headers: { ...githubHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Update MenuWeekly database",
      content,
      sha: expectedSha,
      branch: process.env.GITHUB_BRANCH || "main"
    })
  });
  if (response.status === 409) return { conflict: true };
  if (!response.ok) throw new Error(`GitHub PUT failed (${response.status}): ${await response.text()}`);
  return { conflict: false };
}

export default async function handler(request, response) {
  Object.entries(CORS_HEADERS).forEach(([key, value]) => response.setHeader(key, value));
  if (request.method === "OPTIONS") return response.status(204).end();

  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) {
    return response.status(503).json({ error: "SERVER_NOT_CONFIGURED", message: "MenuWeekly API non configurata." });
  }

  try {
    const current = await getGitHubFile();
    if (request.method === "GET") {
      return response.status(200).json({ data: current.data, version: current.sha });
    }
    if (request.method !== "PUT") return response.status(405).json({ error: "METHOD_NOT_ALLOWED" });

    const expectedSha = request.headers["x-expected-sha"];
    if (!expectedSha || typeof expectedSha !== "string") {
      return response.status(400).json({ error: "EXPECTED_SHA_REQUIRED" });
    }

    const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? "");
    if (body.length > 200000) return response.status(413).json({ error: "PAYLOAD_TOO_LARGE" });

    let data;
    try { data = JSON.parse(body); } catch { return response.status(400).json({ error: "INVALID_JSON" }); }
    if (!validData(data)) return response.status(400).json({ error: "INVALID_DATA" });

    if (current.sha !== expectedSha) {
      return response.status(409).json({ error: "VERSION_CONFLICT", data: current.data, version: current.sha });
    }

    const result = await putGitHubFile(data, expectedSha);
    if (result.conflict) {
      const latest = await getGitHubFile();
      return response.status(409).json({ error: "VERSION_CONFLICT", data: latest.data, version: latest.sha });
    }

    const latest = await getGitHubFile();
    return response.status(200).json({ data: latest.data, version: latest.sha });
  } catch (error) {
    return response.status(500).json({ error: "SERVER_ERROR", message: error instanceof Error ? error.message : "Unknown error" });
  }
}
