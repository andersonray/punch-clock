# WebSocket API

The panel talks to the integration through these Home Assistant WebSocket commands.
By default they require an administrator; the **Only administrators can use Punch
Clock** option turns that off. Errors use the codes `not_loaded`, `not_found`,
`invalid_format`, `limit_exceeded` and `unauthorized`.

The payload shapes match [`frontend/src/types.ts`](../frontend/src/types.ts) and the
model in [`logic/model.py`](../custom_components/punch_clock/logic/model.py). The
server validates every write in full and rejects it without changing anything if any
part is invalid.

| Command | Request fields | Result |
|---|---|---|
| `punch_clock/info` | – | `{version, time_zone, temperature_unit}` |
| `punch_clock/config/get` | – | the full `Config` |
| `punch_clock/subscribe` | – | see below |
| `punch_clock/settings/update` | `changes`: partial `Settings` | `{settings}` |
| `punch_clock/tabs/create` | `tab`: `{name, enabled?, conditions?, defaults?}` | `{tab}` (added as the last tab) |
| `punch_clock/tabs/update` | `tab_id`, `changes` | `{tab}` |
| `punch_clock/tabs/delete` | `tab_id` | `{}`, and the tab's blocks are deleted too |
| `punch_clock/tabs/reorder` | `order`: every tab ID | `{}` |
| `punch_clock/blocks/create` | `blocks`: list of blocks without `id`/`seq` | `{blocks}` (all or nothing) |
| `punch_clock/blocks/update` | `block_id`, `changes` | `{block}` |
| `punch_clock/blocks/update_many` | `updates`: list of `{block_id, changes}` | `{blocks}` (all or nothing, one revision) |
| `punch_clock/blocks/delete` | `block_id` | `{}` |
| `punch_clock/blocks/delete_many` | `block_ids` | `{}` (all or nothing) |
| `punch_clock/conditions/evaluate` | `conditions`: a condition group | an explanation tree: `{id, type, result, items, known?, actual?}` |
| `punch_clock/reapply` | – | `{}`. Writes every desired value that an entity doesn't currently have. |

The server assigns the IDs of new tabs and blocks. When blocks are created, the nested
condition and action IDs are always regenerated, so duplicated blocks never share IDs.

## Subscription

`punch_clock/subscribe` returns an empty result, then sends events:

- `{"kind": "config", "config": Config}` right away and after every change.
- `{"kind": "status", "status": Status}` right away and after every evaluation.

`Status` contains:

- `enabled`, `started`, `evaluated_at`, `next_boundary`
- `tabs`: `{tab_id: {enabled, conditions_met, active}}`
- `blocks`: `{block_id: {in_window, conditions_met, active}}` for every block. The
  conditions are evaluated even outside a block's time window, so the panel can mark
  blocks that wouldn't run right now.
- `desired`: `[{entity_id, key, value, source: {kind, tab_id, block_id}}]`
- `pending`: entities waiting to become available
- `suppressed`: entities whose writes are paused by the write budget
- `errors`: the most recent problems, newest first
