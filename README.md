# Nick Fix CMDB Hardware Lookup

Repo version: `2026.04.16.1`

This is a quick lookup-only ServiceNow **Instance** push connector transform.

It does not insert an event. It reads the incoming `node`, tries to find the best
matching record in `cmdb_ci_hardware`, and returns the full CI record as JSON.

## Endpoint

Create an **Instance** push connector with URL parameter value:

`nickFixCmdbLookup`

Resulting endpoint:

`https://<INSTANCE>/api/sn_em_connector/em/inbound_event?source=nickFixCmdbLookup`

## Payloads

Accepted input styles:

- a single object
- an array of objects
- `{ "records": [...] }`
- `{ "events": [...] }`

Recognized node aliases:

- `node`
- `host`
- `host_name`
- `hostname`
- `server`
- `device`
- `fqdn`
- `name`

## Lookup flow

1. Exact `sys_id` match if `node` looks like a sys_id
2. Exact `name`
3. Exact `fqdn`
4. Exact short-host `name` when `node` looks like an FQDN
5. Fuzzy `name` / `fqdn` contains search with scoring

The response includes:

- lookup status and method
- top candidate breadcrumbs
- the full matched CI record
- `display_values` for fields whose display differs from the raw value

## Files

- `src/cmdbHardwareLookup_transform.js`: the transform to paste into the connector
- `examples/sample_payload.json`: tiny example payload
