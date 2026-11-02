# Assistant history and target regression review

## Findings

- The shared `.plugin-view__body` capped chat views at 820px. On a wide editor pane,
  the entire chat, rather than only its readable text column, stayed on the left.
- Shared menu items had `height: 28px`, including entries with an address or permission
  description. Their children overflowed vertically into neighbouring entries.
- SSH session titles were connection-time snapshots. Host updates changed the saved
  host but left existing native and frontend connection titles untouched. The target
  selector also treated every terminal connection as a separate machine.
- The session selector exposed only switching. The delete button addressed only the
  active conversation, and the engine changed active sessions even when deleting an
  unrelated conversation.
- The old engine persisted an English placeholder, while the frontend translated only
  missing titles. The resulting language depended on whether a session existed yet.

## Reference examined

Reviewed the official VS Code session documentation and current open-source picker on
November 2, 2026:

- https://code.visualstudio.com/docs/copilot/chat/chat-sessions
- https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsPicker.ts

The picker uses a search field and per-item rename/delete buttons, handled separately
from opening a session. The implementation here follows that interaction: a searchable
history dialog, independent open/rename/delete controls, inline rename, and an explicit
delete confirmation that keeps the list available. It uses the existing Tunnelde UI
components and theme tokens; no VS Code extension code is copied.

## Corrections

- Full-width chat viewport and toolbar; centered, bounded message and composer columns.
- Multi-line menu entries grow with their contents, with aligned icons and descriptions.
- Saved-host renames update connection titles without reconnecting. Target grouping uses
  host identity **and the actual connected address**, retaining the selected session or
  otherwise choosing the newest. Different saved hosts or endpoints remain separate.
- History supports search, keyboard navigation, inline rename, cancellation and deletion
  without opening the target conversation. Background runs remain protected until they
  finish. Matching run IDs prevent an old completion event clearing a newer run.
- Semantic untitled metadata allows language changes while preserving custom names.
- Managing another history item preserves the current draft, model and approval choice.
- Provider settings stay in the toolbar; target/workspace options stay in the target menu.

## Verification boundaries

Regression tests cover the reported rename/revert sequence, duplicate target grouping,
selected-connection stability, language changes, explicit placeholder-like titles,
nonactive rename/delete, running-session protection, failure/retry, keyboard focus,
draft retention and background completion. Native and frontend checks are run before
release. These DOM tests do not prove pixel layout.

Local verification passed: the full 693-test frontend suite followed by the updated
five-test history suite (694 tests total in the final suite), 172 native Rust tests,
111 marketplace/plugin tests, TypeScript, ESLint, production build, translation/version
checks, rustfmt and Clippy. Unchanged marketplace entries retain their previous hashes.

No browser/computer tool is available in this session. An earlier automatic approval
review rejected the headless browser launch as blocked by policy; it was not retried
through another launcher. Therefore this batch does not claim rendered screenshot,
macOS interaction, or paid-agent end-to-end verification.
