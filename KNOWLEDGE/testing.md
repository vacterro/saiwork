# Testing

- Focused TypeScript tests run from repository root with `node --import tsx --test <files>` or the equivalent local `tsx --test <files>` binary.
- UI tests importing client-only Solid modules use `node --conditions=browser --import tsx --test --test-force-exit <files>`, matching `.github/workflows/pr-build.yml`.
- Package typechecks are `npm run typecheck --workspace @saiwork/ui`, `@saiwork/saiwork`, and `@saiwork/electron-app`.
- Package builds are `npm run build --workspace <workspace>`.
