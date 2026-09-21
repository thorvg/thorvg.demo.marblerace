# ThorVG Pinrace

A winner picker built as a marble race. Built with [@thorvg/webcanvas](https://www.npmjs.com/package/@thorvg/webcanvas).

## Development

```
$ yarn install
$ yarn dev        # dev server on :3003
$ yarn build      # production build
$ yarn start      # serve the production build
$ yarn lint
```

## URL params

- `?names=Thor,Odin,Freya` — roster, up to 20
- `?seed=ASGARD` — track and outcome
- `?track=short|standard|epic` — 9, 16 or 26 sections (default `standard`)
- `?mode=winner|ranking` — stop at the winner, or run the whole field in (default `winner`)
- `?renderer=sw|gl|wg` — Software, WebGL, WebGPU (default `gl`). Link only, there is no control for it
- `?lang=en|ko` — default `en`. Link only, there is no control for it

## Environment

- `NEXT_PUBLIC_SITE_URL` — pins the host in link preview tags. Without it, read off the request.

