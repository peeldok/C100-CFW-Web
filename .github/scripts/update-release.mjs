import fs from "node:fs";

const owner = "peeldok";
const repo = "Mystrix-CFW";
const api = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "Mystrix-Web-Release-Updater"
};

if (process.env.GH_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
}

const response = await fetch(api, { headers });

if (!response.ok) {
  const body = await response.text();
  throw new Error(`GitHub API ${response.status}: ${body}`);
}

const release = await response.json();
const assets = Array.isArray(release.assets) ? release.assets : [];

const preferred =
  assets.find(asset => /\.uf2$/i.test(asset.name)) ||
  assets.find(asset => /\.(bin|zip)$/i.test(asset.name)) ||
  assets[0] ||
  null;

const tag = release.tag_name || "";
const version = tag.replace(/^v/i, "") || release.name || "Latest";

const metadata = {
  version,
  tag,
  filename: preferred?.name || "Open latest GitHub release",
  downloadUrl: preferred?.browser_download_url || release.html_url || "",
  releaseUrl: release.html_url || `https://github.com/${owner}/${repo}/releases/latest`,
  notes: (release.body || "").trim(),
  publishedAt: release.published_at || "",
  updatedAt: new Date().toISOString()
};

fs.writeFileSync("release.json", JSON.stringify(metadata, null, 2) + "\n");
console.log(JSON.stringify(metadata, null, 2));
