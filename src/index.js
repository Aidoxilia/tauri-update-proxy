import express from "express";

const app = express();

// ---- Config (via variables d'environnement, voir .env.example) ----
const {
  GITHUB_TOKEN,      // PAT GitHub avec accès "Contents: Read-only" sur le repo privé
  GITHUB_OWNER,      // ex: "tonuser"
  GITHUB_REPO,       // ex: "DoEverything"
  API_KEY,           // secret partagé avec l'app Tauri (?api_key=...)
  PORT = 8080,
  CACHE_TTL_SECONDS = 60,
} = process.env;

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !API_KEY) {
  console.error(
    "Missing required env vars: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, API_KEY"
  );
  process.exit(1);
}

const GITHUB_API = "https://api.github.com";

// Petit cache mémoire pour éviter de spammer l'API GitHub (rate limit)
let cache = { data: null, expiresAt: 0 };

async function fetchLatestRelease() {
  const now = Date.now();
  if (cache.data && now < cache.expiresAt) {
    return cache.data;
  }

  const res = await fetch(
    `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }

  const release = await res.json();
  cache = {
    data: release,
    expiresAt: now + Number(CACHE_TTL_SECONDS) * 1000,
  };
  return release;
}

// Middleware d'auth simple par clé partagée
function checkApiKey(req, res, next) {
  if (req.query.api_key !== API_KEY) {
    return res.status(401).json({ error: "Invalid or missing api_key" });
  }
  next();
}

// ---- Route principale consommée par l'updater Tauri ----
// Tauri v1 format attendu: { version, pub_date, url, signature, notes }
// On reconstruit ce JSON dynamiquement à partir des assets de la release GitHub,
// en remplaçant les download_url publics par des liens signés vers NOTRE proxy
// (qui, lui, est authentifié côté serveur avec le token GitHub).
app.get("/updater/:target/:arch/:currentVersion", checkApiKey, async (req, res) => {
  try {
    const release = await fetchLatestRelease();
    const version = release.tag_name.replace(/^v/, "");

    // On cherche le latest.json généré par tauri-action parmi les assets
    const latestJsonAsset = release.assets.find((a) => a.name === "latest.json");
    if (!latestJsonAsset) {
      return res.status(404).json({ error: "latest.json not found in release" });
    }

    // On télécharge le contenu de latest.json en s'authentifiant
    const assetRes = await fetch(latestJsonAsset.url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/octet-stream",
      },
    });
    const manifest = await assetRes.json();

    const platformKey = `${req.params.target}-${req.params.arch}`;
    const platformData = manifest.platforms?.[platformKey];

    if (!platformData) {
      // Pas de mise à jour pour cette plateforme
      return res.status(204).send();
    }

    // Réécrit l'URL de téléchargement pour pointer vers NOTRE proxy
    // (qui servira le binaire en s'authentifiant auprès de GitHub)
    const proxiedUrl = `${req.protocol}://${req.get("host")}/download/${
      release.tag_name
    }/${encodeURIComponent(getAssetNameFromUrl(platformData.url))}?api_key=${API_KEY}`;

    return res.json({
      version: manifest.version ?? version,
      pub_date: manifest.pub_date ?? release.published_at,
      url: proxiedUrl,
      signature: platformData.signature,
      notes: release.body || "",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// ---- Route qui sert le binaire réel, en s'authentifiant auprès de GitHub ----
app.get("/download/:tag/:assetName", checkApiKey, async (req, res) => {
  try {
    const { tag, assetName } = req.params;

    // Récupère la liste des assets de cette release précise (pas forcément "latest")
    const releaseRes = await fetch(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${tag}`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      }
    );
    if (!releaseRes.ok) {
      return res.status(404).json({ error: "Release not found" });
    }
    const release = await releaseRes.json();

    const asset = release.assets.find((a) => a.name === decodeURIComponent(assetName));
    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    // Stream le binaire depuis GitHub vers le client, en s'authentifiant
    const assetRes = await fetch(asset.url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/octet-stream",
      },
    });

    res.setHeader(
      "Content-Type",
      assetRes.headers.get("content-type") || "application/octet-stream"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${asset.name}"`);

    // Pipe le body de la réponse fetch vers la réponse Express
    const reader = assetRes.body.getReader();
    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) return res.end();
      res.write(value);
      return pump();
    };
    await pump();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

function getAssetNameFromUrl(url) {
  // platformData.url dans latest.json pointe vers le browser_download_url GitHub
  // on en extrait juste le nom de fichier final
  return decodeURIComponent(url.split("/").pop());
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`tauri-update-proxy listening on port ${PORT}`);
});
