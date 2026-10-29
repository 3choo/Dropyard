# Contributing

Thanks for helping out. Bug reports, fixes and focused features are welcome.

## Setup

```bash
npm install
npm run dev        # Worker on :8787 (D1 and R2 simulated locally)
npm run dev:web    # Vite UI on :5173, proxies /api, /dl and /git to :8787
```

## Before opening a pull request

```bash
npm run typecheck
npm test
```

CI runs both, plus a production build, and CodeQL scans every pull request.
Add a test with each behaviour change. Tests run inside workerd with local D1
and R2, so they need no cloud account.

Keep pull requests small and describe the why. For larger features, open an
issue first. Do not commit secrets, `.dev.vars` or `wrangler.local.jsonc`.
