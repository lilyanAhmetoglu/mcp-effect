# Contributing

Thank you for helping.

## Set up

```bash
npm install
npm test
```

You need Node.js 22 or newer.

## Before you open a pull request

- `npm run typecheck` passes.
- `npm test` passes.
- A new feature has a test. A bug fix has a test that failed before the fix.
- Public behavior changes are written in `README.md` or `docs/`.

## Two rules this project keeps

1. **State decides, not the model.** We do not add tools that let the model change gateway state.
2. **Fail closed.** When something is unclear or broken, mount nothing.

## Reporting a security problem

Please do not open a public issue. Use GitHub's "Report a vulnerability" button on the Security tab of the repository.
