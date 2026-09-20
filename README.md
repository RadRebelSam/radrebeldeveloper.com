# radrebeldeveloper.com

The home page of **[radrebeldeveloper.com](https://radrebeldeveloper.com)** — a sticker
board of everything that has shipped.

Each project is its own logo, die-cut into a shape generated from its name, dealt into a
pile you can drag around. Nothing on the board is hand-maintained: a scanner finds the
projects through certificate transparency, reads each site for its copy and its favicon,
and decides from the favicon alone whether something has shipped or is still being built.

One static HTML file, no framework, no build step, no dependencies. The only moving parts
are Node scripts that run before deploy, never on the server.

**Live:** https://radrebeldeveloper.com

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole page. No build step, no dependencies. |
| `projects.json` | The manifest the page reads. **Generated — don't hand-edit.** |
| `scan.mjs` | Rebuilds `projects.json` and `icons/` from what is actually live. |
| `pack.mjs` | Zips exactly the uploadable files into `dist/`. Run by `scan.mjs`. |
| `dist/radrebeldeveloper.com.zip` | **This is what you upload.** Unzip into `public_html`. |
| `overrides.json` | Hand-tuned names, taglines, categories, logos. Wins over the scan. |
| `extras.json` | Projects that don't live on a `radrebeldeveloper.com` subdomain. |
| `icons/` | One logo per project, downloaded by the scan. Content-hashed filenames. |
| `assets/brand.jpg` | The radrebeldeveloper mark used in the header. |

## How a new project reaches the board

1. Ship it. Give it a favicon.
2. Run `node scan.mjs` — it rescans, rewrites the manifest and rebuilds the zip.
3. Unzip `dist/radrebeldeveloper.com.zip` into `public_html`.

The scan finds subdomains through **certificate transparency** — every host that gets an
HTTPS certificate is published to the public CT logs within minutes — so nothing has to be
added to a list by hand. It then fetches each host for its title, description and favicon.

**A project with no favicon of its own is treated as still being built and gets no
sticker.** That is the rule that keeps parked subdomains (currently `synapsecanvas`) off
the board. Hostinger's placeholder icon counts as "no favicon".

A host that does not answer at all — deleted DNS, nothing listening — is treated as gone
rather than unfinished and is dropped from the manifest completely. Certificate
transparency remembers every host forever, so this is what stops a subdomain you deleted
from haunting the list. It is tried twice before being written off, so one flaky moment
cannot erase a project that is really still there.

## Keeping logos in step with the sites

Every scan re-downloads each project's favicon — it never trusts the copy on disk. The
file is then named after a hash of its contents:

```
icons/jev.53e1ba38.svg
```

If a site changes its logo the hash changes, so the sticker points at a **new filename**
and no cache anywhere — browser, LiteSpeed, CDN — can keep serving the old picture. If the
logo is unchanged the name is unchanged and there is nothing to re-upload. Superseded
files are deleted at the end of every scan, so `icons/` never accumulates.

The one exception is a logo pinned in `overrides.json` (`"icon": "…"`). That is frozen on
purpose and stops tracking the live site — only pin one when the site has no usable
favicon.

Which means: **keeping the logos current is the same job as keeping the board current —
run the scan, then deploy.**

## Categories

`chrome-extension · obsidian-plugin · saas · skill · directory · site · misc`

The scan guesses from the page copy; `overrides.json` is where the answer is actually
decided:

```json
{ "rewordly": { "category": "chrome-extension" } }
```

## Projects outside the domain

Add the host to `extras.json` — a path is allowed:

```json
{ "hosts": ["clawconnected.com", "radrebelsam.github.io/awesome-jev"] }
```

## Keeping it fresh automatically

`.github/workflows/scan.yml` runs the scan every morning, commits whatever changed, and
uploads the site to Hostinger over FTPS. It also runs on demand from the Actions tab, and
on any push that touches `index.html`, `assets/`, `overrides.json` or `extras.json`.

Setting it up:

1. Put this folder in a GitHub repository (`main` branch).
2. hPanel → Files → **FTP Accounts** — note the host, username and password.
3. GitHub → repo → Settings → Secrets and variables → **Actions** → New repository secret:
   - `FTP_HOST` — e.g. `ftp.radrebeldeveloper.com`
   - `FTP_USER` — e.g. `u123456789`
   - `FTP_PASS` — the FTP password
   - optionally a *variable* (not secret) `FTP_DIR` if your account doesn't land on
     `/public_html`
4. Actions tab → **scan and deploy** → Run workflow, to prove it end to end.

The password never appears in the workflow file or the logs — it is handed to curl over
stdin. The upload demands explicit FTPS and fails rather than falling back to plain FTP;
`FTP_INSECURE=1` relaxes that if your host can't do TLS.

On Windows without CI, Task Scheduler running `node scan.mjs` in this folder does the
scanning half, and `./deploy.sh ftp` the upload.

### The other way: let Hostinger pull

hPanel → Websites → **Advanced → GIT** can point `public_html` at a repository and deploy
on demand, with a webhook URL you can `curl` from the workflow instead of uploading. That
keeps FTP credentials out of GitHub entirely. It expects the site at the repository root,
so it suits this project only if you move the toolchain files into a subfolder.

## Deploying to Hostinger

The site is static — there is nothing to build. Four things get uploaded:

```
index.html
projects.json
icons/
assets/
```

`scan.mjs`, `overrides.json`, `extras.json`, `deploy.sh` and this README stay on your
machine. They are the toolchain, not the site.

### Shared hosting (what radrebeldeveloper.com is on today)

The apex currently serves Hostinger's placeholder, so `public_html` already exists and
holds a default `index.html` that this replaces.

**Subdomains are not touched.** On Hostinger each subdomain has its own document root —
`domains/<sub>.radrebeldeveloper.com/public_html` — a sibling of the apex root, not a
folder inside it. The deploy writes four things (`index.html`, `projects.json`, `assets/`,
`icons/`) into the apex root and nothing else; it never deletes and never recurses
elsewhere. Worth confirming your own layout in the File Manager once before the first run.

**By hand:** hPanel → Files → File Manager → `domains/radrebeldeveloper.com/public_html`,
delete the placeholder `index.html`, upload `dist/radrebeldeveloper.com.zip` and use the
file manager's Extract — the paths inside are already relative to the site root.

**By script:** grab the FTP details from hPanel → Files → FTP Accounts, then

```bash
FTP_PASS='your-ftp-password' FTP_HOST=ftp.radrebeldeveloper.com FTP_USER=uXXXXXXXX   ./deploy.sh ftp
```

`FTP_DIR` defaults to `/public_html`; set it if your account lands somewhere else.

### VPS

```bash
SSH_TARGET=root@your.vps.ip SSH_DIR=/var/www/radrebeldeveloper.com ./deploy.sh ssh
```

Point the nginx/Apache docroot at that directory. Nothing else is needed — no Node on the
server, no process to keep alive.

### After a scan

`node scan.mjs` rewrites `projects.json`, `icons/`, the inline copy inside `index.html`
and the zip, so re-run the deploy afterwards. If you edit the page by hand instead, run
`node pack.mjs` to refresh the zip on its own. If the page still looks stale, purge
hPanel → Websites → Advanced → Cache Manager, then hard-refresh.

## Notes

- `index.html` carries an inline copy of the manifest so it still works opened from disk.
  `scan.mjs` rewrites that copy; the block is marked `@generated:fallback`.
