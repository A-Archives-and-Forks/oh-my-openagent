# Senpi Telemetry Reference

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

## Identity model

## Opt-out matrix

## What is never collected

## Preview and audit
