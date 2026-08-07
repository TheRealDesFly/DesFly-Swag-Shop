# Weather Dashboard (DesFly docs/)

This branch (wix-mirror) contains a small static weather dashboard placed into `docs/` so it can be deployed with GitHub Pages when the branch is merged to `main` and Pages is configured to serve from `docs/`.

Files added:
- docs/index.html — the dashboard UI and a link to your Wix homepage (brand root).
- docs/style.css — styles for the dashboard.
- docs/script.js — frontend JavaScript using Nominatim (geocoding) + Open-Meteo (weather).

Notes:
- I kept the Wix homepage (https://therealdesfly.wixsite.com/desflyfuturebrand) as the main brand link inside the dashboard. You previously selected the Wix homepage as the site root (A).
- I did not scrape the Wix HTML/CSS/JS — Wix often uses dynamic, proprietary scripts that do not port cleanly. If you want the Wix pages mirrored into `docs/`, I can attempt to fetch static HTML and assets, but that process requires reviewing each page for dynamic widgets and may require manual fixes. Tell me which pages to prioritize (home + /sports), and I will fetch them and include them in the PR.

Next steps I can take (pick any):
- Open a Pull Request from `wix-mirror` → `main` with these changes (I can draft the PR body and checklist).
- Attempt to mirror the Wix homepage and /sports page into `docs/` (I will fetch public HTML/assets and report items that need manual work).
- Add a GitHub Pages deployment checklist and instructions for enabling Pages on `main` serving `/docs`.

Which would you like me to do next? (e.g., "Open PR", "Mirror Wix home + sports", "Add Pages instructions")
