# Project checks

- Offline runtime suite: `npm --prefix runtime test`.
- Mobile Spaces suite: `node --test test/spaces-mobile.test.mjs`.
- Cross-project acceptance (the bundle in a real pi-serverd): `npm --prefix ../phi-spaces run test:agent`.
- Do not run `runtime/test-remote-client.mjs` without explicit approval: it creates a real remote session and may make paid model calls.

# Runtime dependencies

- Agent-side Earendil packages are pinned to 1.5.2; schema builders come from `@earendil-works/pi-schema`.
- Remote conversations need no pi-server/pi-client: pi-serverd answers them as calls over a space (`runtime/remote-calls.mjs`), on its conversation socket (reached over SSH) and optionally over a federation Space. One Chord, 1.5.2, no overrides.
- `runtime/common.mjs` adapts Conversation watches to self-contained snapshots for local SSE and remote polling. ConversationTranscript retains and pages history across watch windows.
- Regenerate `runtime/phi-spaces.mjs` and the mobile example modules using `npm --prefix ../phi-spaces run bundle`; do not hand-edit generated bundles.
