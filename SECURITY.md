# Security policy

## Supported versions

Security fixes land on the default branch and in the next release. Older
releases are not patched.

## Reporting a vulnerability

**Please don't open a public issue for security problems.** Use GitHub's
[private vulnerability reporting](../../security/advisories/new) for this
repository. Include steps to reproduce, the affected version/commit and the
impact you expect. You'll get an acknowledgement within a few days, and we'll
keep you updated until a fix is released. We're happy to credit you in the
release notes.

## Running Spatial Map safely

- Change **every** placeholder secret before exposing an instance: `SGV_AUTH.JWT_SECRET`,
  `SGV_AUTH.API_KEY`, database and object-storage passwords (see
  `backend/.env.example`). The API refuses to start in production mode with the
  development placeholders.
- Put the API and SPA behind HTTPS (a reverse proxy such as Caddy or nginx).
- Restrict your Mapbox token to your own domains in the Mapbox dashboard.
- Keep PostgreSQL, MinIO and Redis off the public internet.
