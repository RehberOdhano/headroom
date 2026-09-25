# @headroom/extension

The browser extension half of headroom ("Claude Usage Companion"): WXT + React + Dexie, built for
Chrome/Edge (`chrome-mv3`) and Firefox (`firefox-mv2`) from one source tree. It works standalone;
the optional daemon (`packages/daemon`) unlocks the CLI-side features.

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/chjbjdabpficejgogljohhlobfaehepl),
or see the [root README](../../README.md) for building from source and the full feature list.

```sh
pnpm --filter @headroom/extension run dev         # dev build, Chrome (":firefox" suffix for Firefox)
pnpm --filter @headroom/extension run build       # production build -> .output/chrome-mv3
pnpm --filter @headroom/extension run test
```

Contributor notes (content-script world boundary, MV2/MV3 differences, background worker
patterns) live in [`CLAUDE.md`](./CLAUDE.md).
