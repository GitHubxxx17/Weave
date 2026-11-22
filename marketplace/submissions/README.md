# Community plugin submissions

Each `<plugin-id>.json` contains one strict marketplace plugin entry. The
checked-in `../index.json` is generated from these entries; do not edit it by hand.
No community plugins have been collected yet.

Read [the publishing guide](../../docs/learning/plugin-marketplace-publishing.md)
for build requirements, preparing an entry, version updates and review. Run:

```sh
pnpm marketplace:generate
pnpm marketplace:check
```

These two commands work offline and never execute plugin code. The optional
`marketplace:entry` helper explicitly downloads a pinned public GitHub payload to
read its descriptor. It creates a submission for review, without installing or
publishing that payload.
