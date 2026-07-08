# Spanwright

Spanwright is a browser-based bridge planner for Minecraft and other voxel building games. Shape a bridge curve, tune its rise, width, and thickness, then inspect the result as a buildable block model in WebGL.

## Features

- Parabolic, catenary, and circular bridge profiles
- Adjustable span, rise, deck width, and structural thickness
- Buildable voxel stepping and optional edge railings
- Orbit, elevation, and plan views
- Live block counts, footprint, height, and elevation profile
- JSON plan export organized by build layer
- No runtime dependencies or build step

## Run locally

Any static file server will work. For example:

```sh
npx serve .
```

Then open the local address shown in the terminal.

## Deploy to Cloudflare Pages

This repository includes a GitHub Actions workflow for automatic Cloudflare Pages deployments. Every push to `main` publishes the static site.

Create a Cloudflare Pages project named `spanwright`, then add these repository secrets in GitHub:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with Pages edit permission
- `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare account ID

Alternatively, connect the GitHub repository directly from the Cloudflare Pages dashboard. Use `/` as the root directory and leave the build command blank.

## AI-assisted design notice

Large language models were used to help design and implement this project. The project remains intended for human review, iteration, and creative use.

## License

[MIT](./LICENSE)
