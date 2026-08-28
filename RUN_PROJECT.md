# DevX Nexus — Run Guide

## Open in VS Code
1. Extract this ZIP.
2. Open the `devx-nexus` folder itself in VS Code.
3. Open the VS Code terminal in that folder.

## Install and run
```bash
npm install
npm start
```

Then open:
- Customer app: http://localhost:3000
- Admin panel: http://localhost:3000/admin
- Health check: http://localhost:3000/api/health

## Important
- Node.js 18 or newer is required.
- `data/db.json` is included and contains the existing project data and catalogue state.
- `seed.json` is included as a catalogue fallback.
- Do not move `public/index.html` out of the `public` folder; the server serves the frontend from there.
- The ZIP intentionally excludes `.env` and `node_modules`. Use `.env.example` if you need to configure AI or other integrations.

## Included fixes/features
- Existing product catalogue preserved and API-tested (1043 products available).
- Add products to an existing order with catalogue search and quantity controls.
- AED 15 minimum and admin approval flow.
- One consolidated order/payment total including weight adjustments and approved additions.
- Additional products remain available until dispatch and then lock automatically.
- Customer phone detection on checkout.
- Existing user sign-in and new-user account creation using a 4-digit PIN.
- Customer order processing alert and notifications for preparation, dispatch/out-for-delivery, and completion.
- Voice recording cancel/cut and send controls.
- Home-only “Forgot Something?” prompt for eligible orders.
- Dark/light theme synchronization for the post-order prompt and Add More Products interface, plus a theme-aware desktop backdrop.
- Existing UI and remaining functionality retained from the supplied project.
