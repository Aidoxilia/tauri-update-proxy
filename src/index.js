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

// Mapping target+arch Tauri -> motif attendu dans le nom de fichier installeur.
// Adapte/complète cette table si tu ajoutes d'autres plateformes (mac, linux).
const ASSET_PATTERNS = {
  "windows-x86_64": /_x64-setup\.exe$/i,
  "windows-i686": /_x86-setup\.exe$/i,
  "windows-aarch64": /_arm64-setup\.exe$/i,
  "darwin-x86_64": /_x64\.app\.tar\.gz$/i,
  "darwin-aarch64": /_aarch64\.app\.tar\.gz$/i,
  "linux-x86_64": /_amd64\.AppImage$/i,
};

// ---- Route principale consommée par l'updater Tauri ----
// On reconstruit la réponse attendue par tauri-plugin-updater directement à
// partir des noms d'assets de la release (pas besoin de latest.json).
// Convention attendue dans les assets : un fichier installeur (ex: ..._x64-setup.exe)
// + son fichier de signature au même nom + ".sig".
app.get("/updater/:target/:arch/:currentVersion", checkApiKey, async (req, res) => {
  try {
    const release = await fetchLatestRelease();
    const version = release.tag_name.replace(/^v/, "");

    // Si la version courante du client est déjà à jour, pas de mise à jour
    if (req.params.currentVersion === version) {
      return res.status(204).send();
    }

    const platformKey = `${req.params.target}-${req.params.arch}`;
    const pattern = ASSET_PATTERNS[platformKey];
    if (!pattern) {
      return res
        .status(404)
        .json({ error: `Unsupported platform: ${platformKey}` });
    }

    const installerAsset = release.assets.find((a) => pattern.test(a.name));
    if (!installerAsset) {
      return res.status(404).json({
        error: `No installer asset matching ${platformKey} found in release ${release.tag_name}`,
        availableAssets: release.assets.map((a) => a.name),
      });
    }

    const sigAsset = release.assets.find(
      (a) => a.name === `${installerAsset.name}.sig`
    );
    if (!sigAsset) {
      return res.status(404).json({
        error: `Signature file ${installerAsset.name}.sig not found in release`,
        availableAssets: release.assets.map((a) => a.name),
      });
    }

    // Télécharge le contenu (texte) du fichier .sig en s'authentifiant
    const sigRes = await fetch(sigAsset.url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/octet-stream",
      },
    });
    const signature = (await sigRes.text()).trim();

    // URL de téléchargement réécrite pour pointer vers notre proxy
    const proxiedUrl = `${req.protocol}://${req.get("host")}/download/${
      release.tag_name
    }/${encodeURIComponent(installerAsset.name)}?api_key=${API_KEY}`;

    return res.json({
      version,
      pub_date: release.published_at,
      url: proxiedUrl,
      signature,
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

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`tauri-update-proxy listening on port ${PORT}`);
});