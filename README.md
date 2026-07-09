# Spanwright

Spanwright is a browser-based bridge planner for Minecraft and other voxel building games. Shape a bridge curve, tune its rise, width, and thickness, then inspect the result as a buildable block model in WebGL.

## Features

- Parabolic, catenary, and circular bridge profiles
- In-world custom curve handles with axis-constrained dragging
- Movable start and end elevations for uneven banks
- Global rotation for voxelized diagonal bridges
- Optional mirrored curve editing
- Point reordering, targeted deletion, and undo with Command/Ctrl+Z
- Adjustable span, rise, deck width, and structural thickness
- Buildable voxel stepping and optional edge railings
- Orbit, elevation, and plan views
- Live block counts, footprint, height, and elevation profile
- JSON plan export organized by build layer
- No runtime dependencies

## Run locally

Any static file server will work. For example:

```sh
npx serve .
```

Then open the local address shown in the terminal.

## Deploy to Cloudflare

This repository is configured for Cloudflare's Git integration. The build copies the public site into `dist/`, and Wrangler deploys only that directory as static assets.

Connect the GitHub repository from **Workers & Pages** in the Cloudflare dashboard, then use:

- Production branch: `main`
- Build command: `npm run build`
- Deploy command: `npm run deploy`
- Root directory: leave blank

No GitHub Actions secrets are required. Every push to `main` builds and deploys the site through Cloudflare.

## AI-assisted design notice

Large language models were used to help design and implement this project. The project remains intended for human review, iteration, and creative use.

## License

[MIT](./LICENSE)
