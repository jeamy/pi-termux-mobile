# Project checks

- Offline runtime suite: `npm --prefix runtime test`.
- Mobile Spaces suite: `node --test test/spaces-mobile.test.mjs`.
- Cross-project Pi-server acceptance: `npm --prefix ../phi-space run test:agent`.
- Do not run `runtime/test-remote-client.mjs` without explicit approval: it creates a real remote session and may make paid model calls.

# Runtime dependencies

- Agent-side Earendil packages are pinned to 1.5.0; schema builders come from `@earendil-works/pi-schema`.
- `pi-client` and `pi-server` remain at their latest published version, 1.1.0, with transport-side Chord pinned to 1.1.0 through overrides. Keep this separate from the agent Harness's Chord.
- `runtime/common.mjs` adapts Conversation watches to self-contained snapshots for local SSE and remote polling. ConversationTranscript retains and pages history across watch windows.
- Regenerate `runtime/phi-spaces.mjs` and the mobile example modules using `npm --prefix ../phi-space run bundle`; do not hand-edit generated bundles.
