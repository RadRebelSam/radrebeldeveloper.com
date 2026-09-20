# radrebeldeveloper.com

A sticker board of everything that has shipped. Each project is its own logo, die-cut into
a shape generated from its name, dealt into a pile you can drag around.

**Live:** https://radrebeldeveloper.com

One static HTML file — no framework, no build step, no dependencies. The Node scripts run
before deploy, never on the server.

## Files

| | |
| --- | --- |
| `index.html` | The whole page. |
| `projects.json` | What the page reads. **Generated — don't hand-edit.** |
| `scan.mjs` | Rebuilds the manifest, the icons and the zip from what is live. |
| `pack.mjs` | Zips the uploadable files into `dist/`. |
| `deploy.sh` | Uploads them to Hostinger over FTPS. |
| `overrides.json` | Hand-set names, taglines, categories. Wins over the scan. |
| `extras.json` | Projects not on a `radrebeldeveloper.com` subdomain. |

## Adding a project

Ship it with a favicon, then `node scan.mjs`. That's it — subdomains are discovered through
certificate transparency, so nothing is maintained by hand.

**No favicon of its own = still being built.** It is listed in the menu under IN PROGRESS
with a grey dot, and kept off the board. A host that has stopped answering is dropped
entirely.

Categories are guessed from the page copy and settled in `overrides.json`:

```json
{ "rewordly": { "category": "chrome-extension" } }
```

`chrome-extension · obsidian-plugin · saas · skill · directory · site · misc`

## Deploying

`.github/workflows/scan.yml` scans daily, commits what changed and uploads to Hostinger.
It needs three secrets and, where your host differs from the defaults, two variables — all
of them straight off hPanel → Files → **FTP Accounts**:

| hPanel row | Add as |
| --- | --- |
| FTP IP (hostname) | secret `FTP_HOST` |
| FTP username | secret `FTP_USER` |
| *Forgot your FTP password?* | secret `FTP_PASS` |
| Folder to upload files | variable `FTP_DIR` — skip if `/public_html` |
| FTP port | variable `FTP_PORT` — skip if `21` |

Use the **hostname**, not the IP: the upload demands FTPS, and a certificate cannot match
a bare address. If the host still serves a certificate for its own name, set the variable
`FTP_INSECURE` to `1` — the upload stays encrypted, it just stops checking who answers.

By hand instead: `node scan.mjs`, then unzip `dist/radrebeldeveloper.com.zip` into
`public_html`, or run `./deploy.sh ftp` with those values in the environment.

Subdomains are untouched either way — they have their own document roots, and the upload
only ever writes `index.html`, `projects.json`, `assets/` and `icons/` into the apex one.

## Notes

- Icons are named after a hash of their contents, so a changed logo can never be served
  stale from a cache, and superseded files are pruned each scan.
- `index.html` carries an inline copy of the manifest so it still works opened from disk.
  `scan.mjs` rewrites it; the block is marked `@generated:fallback`.
