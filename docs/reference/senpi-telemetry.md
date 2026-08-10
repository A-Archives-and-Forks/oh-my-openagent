# Senpi Telemetry Reference

## What this is

OmO Native is the anonymous product analytics pipeline for the omo-senpi adapter. It's on by default: opt-out, never opt-in. Every switch in the opt-out matrix below turns it fully off.

The payloads carry only booleans, buckets, counters, and allowlisted enum values. No free-form text ever leaves your machine. The exact schema is machine-generated below; if the generator and this document ever disagree, a drift test fails in CI.

<!-- BEGIN GENERATED SCHEMA -->
## Event schema

| Event | Allowed properties |
|-------|--------------------|
| `daily_active` | `$session_id`, `day_utc`, `reason` |
| `session_started` | `$session_id`, `$os`, `$os_version`, `arch`, `cpu_count`, `default_model`, `default_provider`, `memory_bucket`, `model_count`, `provider_count`, `providers`, `reason` |
| `prompt_submitted` | `$session_id`, `input_source`, `invocation_stage`, `is_effective_ultrawork_invocation`, `is_real_user_prompt`, `is_turn_start`, `keyword_any`, `keyword_occurrence_bucket`, `keyword_ultrawork_full`, `keyword_ulw_abbrev`, `keyword_variant`, `prompt_length_bucket`, `queue_mode`, `real_prompt_ordinal_bucket`, `suppression_reason` |
| `turn_completed` | `$session_id`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `input_tokens`, `model_id`, `output_tokens`, `provider`, `reasoning_tokens`, `total_tokens`, `turn_index` |
| `skill_loaded` | `$session_id`, `skill_name` |
| `delegation_started` | `$session_id`, `background`, `batch_size_bucket`, `kind`, `name` |
| `feature_used` | `$session_id`, `feature` |
<!-- END GENERATED SCHEMA -->

### Reasoning tokens caveat

`turn_completed` reports `reasoning_tokens`. That field is optional and is a subset of `output_tokens`, not an addition to it. Never add `reasoning_tokens` to `output_tokens` when computing totals, or you double count.

## Identity model

Identity is machine-level, not person-level:

- The anonymous machine id is `sha256("omo-senpi:" + hostname)`. The raw hostname never leaves the machine; it's only hashed locally.
- The `$session_id` value is a keyed hash: a per-machine random salt combined with the raw session id, then hashed. The raw session id is never sent, and sessions from different machines can't be correlated by session id.
- Person profiles are disabled on every event (`$process_person_profile: false`), so PostHog builds no person records.
- Geoip enrichment is disabled for these events, so no location is derived from the sending IP.

Because identity is machine-level, a shared machine conflates its users into one id. That's an accepted, documented limitation, not a bug.

## SDK-added properties

PostHog's node client attaches a few properties of its own to every event: `$lib`, `$lib_version`, and, because geoip is disabled, `$geoip_disable`. These are transport metadata added by the SDK, not authored by the omo-senpi client, so they don't appear in the allowlists above. They're listed here so an auditor comparing captured payloads against the schema isn't surprised.

## Opt-out matrix

Each switch below turns telemetry fully off: both the OmO Native events in the schema above and the legacy `omo_senpi_daily_active` event.

| Switch | Value that disables | Notes |
| ------ | ------------------- | ----- |
| `DO_NOT_TRACK` | `1` | The consoledonottrack.com convention, honored across all omo adapters |
| `OMO_SENPI_DISABLE_POSTHOG` | `1` | Adapter-specific kill switch |
| `OMO_DISABLE_POSTHOG` | `1` | Global kill switch across omo packages |
| `OMO_SENPI_SEND_ANONYMOUS_TELEMETRY` | any opt-out value, including `yes` | See the quirk note below |
| `OMO_SEND_ANONYMOUS_TELEMETRY` | any opt-out value, including `yes` | See the quirk note below |
| `omo.json` | `telemetry.enabled: false` | Config-file opt-out |
| Component flag | `omo-senpi-telemetry-disabled` | Per-component disable flag |

Quirk, documented honestly: the `*_SEND_ANONYMOUS_TELEMETRY` variables treat the value `yes` as an opt-out. This is a pre-existing behavior in the shared telemetry core, knowingly preserved for compatibility. Don't set `yes` expecting it to opt in; leaving the variable unset is what keeps telemetry on.

## What is never collected

The following never leaves your machine:

- Prompt or response text, prompt fragments, or exact prompt lengths (only coarse buckets)
- File paths, the working directory, or repository and project names
- Git identities or environment variable values
- Raw hostnames or IP addresses
- Custom (non-builtin) skill names
- Custom provider or model names, which are masked to `custom`

A structural allowlist enforces this rather than relying on discipline: any property key not in the allowlist is dropped before send, and any string value on a key ending in `_text`, `_path`, or `_prompt` is rejected regardless of allowlisting.

## Preview and audit

Run the `omo-telemetry` command to see, on your own machine:

- the current enabled state
- the opt-out matrix and which switch, if any, is active
- the last captured payloads: a 50-entry ring buffer, mirrored to `last-payloads.json` in the telemetry state directory

That mirror shows exactly what was sent, byte for byte, so you can verify the claims in this document against real traffic.
