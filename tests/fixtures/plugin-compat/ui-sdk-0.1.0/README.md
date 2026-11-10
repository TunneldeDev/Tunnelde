# Historical UI SDK fixture

`contract.d.ts` is the public experimental UI SDK 0.1.0 declaration before its
domain split. Keep this snapshot unchanged. The compatibility test compiles both
entry points, compares all exports, and checks assignments in both directions.
This verifies the type-preserving reorganization, not a new API stability promise.
