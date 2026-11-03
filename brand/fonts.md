# Fonts: RadRebelDeveloper

Audited 2026-10-18 against the generators, not guessed from the lockup SVGs.

| Use | Font | Source |
|---|---|---|
| RR glyph and the suffix word on every tile and banner | Arial Rounded MT Bold | `radrebelsam.com/brand/make_favicons.py`, `make_banners.py` (`C:\Windows\Fonts\ARLRDBD.TTF`) |
| Site body | Inter, then -apple-system, Segoe UI, Helvetica, Arial | `radrebeldeveloper.com/index.html` |
| Lockups in `brand/logo/` | Segoe UI 700 stack | `dashboard/rr_lockups.py` (does not match the tile font; see the open point below) |

Open point: the lockups were drawn with Segoe UI while the tiles use Arial Rounded MT Bold. One of the two should change so the family uses one typeface. Licence: Arial Rounded MT Bold ships with Windows (Monotype); check the licence before embedding it on the web.
