# Kikoeru Express

Kikoeru is a self-hosted library and streaming player for locally owned DLsite audio works. This repository provides the Express backend, SQLite library database, metadata scanner, and Docker image build.

It is maintained together with the Vue/Quasar frontend in [kikoeru-quasar](https://github.com/camemb3rt/kikoeru-quasar).

## Highlights in this fork

- English-first metadata scraping from DLsite and ASMR.one, with HVDB as a fallback.
- Translation-aware cover downloads: translated work IDs are resolved to the original DLsite cover artwork, with ASMR.one cover fallback.
- Support for `.lrc`, `.vtt`, and `.srt` lyric/subtitle files.
- Per-work metadata refreshes with live scanner logs and missing-cover retrieval.
- English scanner and metadata refresh messages.
- Persistent user favourites, reviews, ratings, and listening progress.
- Improved Library and Favourites tag search, filtering, highlighting, and per-tag removal controls.
- Mobile lyric-overlay improvements and Media Session controls with work artwork.
- Lyric/subtitle drag, resize, visibility, and audio-pause synchronization fixes.
- Node.js 20+ local development support; the current Docker image uses Node 24.

## Local development

Requirements: Node.js 20 or newer and the companion frontend checkout.

```bash
npm ci
$env:PORT = '5232' # PowerShell
node app.js
```

The backend listens on `http://localhost:5232`. Start the frontend separately on port `5233` for development.

## Docker build

The backend Dockerfile builds and bundles the frontend through a named build context. Keep both repositories beside each other:

```text
kikoeru/
├── kikoeru-express/
└── kikoeru-quasar/
```

From `kikoeru-express`:

```bash
docker build --build-context frontend=../kikoeru-quasar -t kikoeru .
docker run --rm -p 5232:5232 \
  -v kikoeru-sqlite:/usr/src/kikoeru/sqlite \
  -v kikoeru-config:/usr/src/kikoeru/config \
  -v kikoeru-covers:/usr/src/kikoeru/covers \
  kikoeru
```

The image exposes port `5232` and serves the bundled frontend from the same address. The separate Quasar development server uses port `5233`.

## Docker Compose

Copy [`docker-compose.example.yml`](docker-compose.example.yml) to `docker-compose.yml`, then create a `library` folder beside it (or replace that bind mount with the path to your existing library):

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

Open `http://localhost:5232`, then add `/library` as a root folder in the Admin Panel. The bundled frontend is served by the backend container, so port `5233` is only used for local frontend development.

### Region-locked metadata providers

Some metadata and cover providers, including ASMR.one, may be region-locked. For reliable scraping in those situations, use a VPN endpoint permitted by the service or route the Kikoeru container through a VPN gateway such as [Gluetun](https://github.com/qdm12/gluetun). Keep VPN credentials in an untracked `.env` file or your container platform's secret store—never commit them. When using Gluetun's `network_mode: service:gluetun`, publish port `5232` on the Gluetun service rather than on Kikoeru itself.

## Project layout

- `routes/` — HTTP API routes.
- `filesystem/` — library scanner, metadata refresh, and subtitle detection.
- `scraper/` — DLsite, ASMR.one, and HVDB metadata providers.
- `database/` — SQLite schema, migrations, and queries.
- `covers/` — downloaded cover images at runtime.
- `dist/` — bundled frontend assets in the final image.

## License

GNU General Public License v3.0.
