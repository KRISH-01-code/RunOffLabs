# Deploying RunoffLab

RunoffLab is two services:

- **backend**: FastAPI + EPA SWMM (PySWMM). Stores projects in SQLite at
  `/data/runofflab.db`, so give it a persistent volume.
- **frontend**: Next.js. The browser only talks to it; it forwards `/api/*`
  to the backend. The backend's address is fixed **when the frontend image is
  built** (build argument `RUNOFFLAB_API_URL`), because Next.js bakes
  rewrites into the build.

Both have a Dockerfile, and `docker-compose.yml` at the repository root runs
them together. That setup is tested: the containers reproduce the reference
SWMM results exactly (runoff 576 m³, peak 0.291 m³/s for the sample design),
the Design Explorer runs its worker processes, and saved projects survive a
restart.

> **Before you put it on the public internet:** RunoffLab has no user
> accounts. Anyone who can open the URL can edit or delete every project and
> start CPU-heavy Explorer runs. Put a password in front of it (option 2 shows
> how), or share it only on a private network, until accounts exist.

## 1. On your own computer

```bash
docker compose up --build          # http://localhost:3000
RUNOFFLAB_PORT=8080 docker compose up --build   # a different port
docker compose down                # stop (projects are kept)
docker compose down -v             # stop and delete saved projects
```

## 2. On a server (any VPS with Docker), with HTTPS and a password

This is the simplest way to a public link, and it uses the tested compose
setup unchanged. You need a small Linux server (1–2 vCPU, 2 GB RAM is
plenty), Docker installed on it, and a domain name pointing at it.

1. Copy the repository to the server and start it on a local port:

   ```bash
   RUNOFFLAB_PORT=3000 docker compose up -d --build
   ```

2. Put [Caddy](https://caddyserver.com) in front of it for automatic HTTPS
   and a password. Create a password hash with
   `caddy hash-password --plaintext 'choose-a-password'`, then use this
   `Caddyfile` (replace the domain and the hash):

   ```caddyfile
   runofflab.example.com {
       basic_auth {
           demo $2a$14$replace-with-the-hash-from-caddy-hash-password
       }
       reverse_proxy localhost:3000
   }
   ```

   Run `caddy run` (or install it as a service). Caddy fetches the TLS
   certificate itself. Visitors sign in as `demo` with your password.

3. Updating later: `git pull && docker compose up -d --build`.

## 3. On a platform that runs Docker images (Render, Fly.io, Railway, …)

Create **two services** from the two Dockerfiles. The details differ by
platform, but the shape is always:

| | backend | frontend |
|---|---|---|
| Dockerfile | `backend/Dockerfile` | `frontend/Dockerfile` |
| Port | `$PORT` (defaults to 8000) | 3000 |
| Storage | a persistent disk or volume mounted at `/data` | none |
| Build setting | none | `RUNOFFLAB_API_URL` = the backend's private address, e.g. `http://runofflab-backend:8000` |
| Public? | no: keep it private if the platform allows | yes |

Things to check on your platform:

- **Persistent disk.** Without one, projects are lost on every redeploy.
  Some platforms only offer disks on paid plans.
- **Build arguments.** `RUNOFFLAB_API_URL` must reach the frontend image at
  *build* time. Platforms differ in how build arguments are set; on Fly.io,
  for example, it's `fly deploy --build-arg RUNOFFLAB_API_URL=…`.
- **Private networking.** If the platform's private network uses IPv6 (Fly.io
  does), start the backend listening on IPv6 too by overriding its command
  with `uvicorn runofflab.api.app:app --host :: --port 8000`. This variant
  hasn't been tested here.
- **CPU.** The Design Explorer runs up to four SWMM worker processes, so
  more vCPUs make it faster; 200 designs take about 5 s on 4 cores.
- **Password.** Most platforms don't add one for you, so prefer option 2 for
  a public demo, or add your own authentication before sharing the link.

## What isn't needed

No API keys, no external services, no database server: SQLite lives in the
backend's volume, and the SWMM engine ships inside the PySWMM wheel.
