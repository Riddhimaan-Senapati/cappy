# browser-agent
hackumass project

## Demo pages

Pages in `scripts/fixtures/` used by the demo and the e2e tests:

- `campus.html`: "Pioneer Valley Campus Daily". Px-based 12px text, low-contrast gray, a red ticker with a CSS animation, a crowded sidebar with 10px links, an inline ad banner, a color-only status table, a placeholder-only sign-up form with positive tabindex, and an image without alt. Checked by `bun scripts/e2e-campus.ts`.
- `injection.html`: a customer survey with hidden instructions aimed at the agent (clipped and off-screen). The backend guard must block it. Checked by `bun scripts/e2e-injection.ts`.
- `form.html`: a contact form for the form fixer. Checked by `bun scripts/e2e-form.ts`.
- `chart.html`, `feed.html`, `plain.html`: charts, a scrolling feed, and a plain survey used by the other e2e scripts.

To serve them locally for a manual demo (port 5199, or set `PORT`):

```sh
bun scripts/serve-fixtures.ts
# open http://localhost:5199/campus.html
```
