# Compiled dispatcher runtime receipt

## What was tested

An isolated Bun driver imported the compiled-entry dispatcher
`runCompiledLauncher()` from source and ran:

```text
setup --yes
migrate --yes
```

It set HOME, USERPROFILE, XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME,
XDG_CACHE_HOME, OMO_CODING_AGENT_DIR, SENPI_CODING_AGENT_DIR, and
PI_CODING_AGENT_DIR to a disposable temporary root.

## What was observed

The driver exited `0` and read these generated target values before deleting
the temporary root:

```json
{
  "auth": {
    "openai": {
      "type": "api_key",
      "key": "dummy-key"
    }
  },
  "settings": {
    "defaultProvider": "anthropic",
    "defaultModel": "claude-opus-4-5"
  },
  "migrationState": {
    "items": {
      "settings": true,
      "agents": true
    }
  }
}
```

## Why this is sufficient

This confirms the shared compiled-entry dispatcher invokes setup and migrate
and both make their real, expected configuration changes. The disposable root
was removed after the run, so no actual user auth or configuration location was
read or written. The separately built executable receipt records its unresolved
packaging asset failure.

## Omitted

Only a dummy API key was used. Setup's verbose report and all environment
values are omitted to avoid retaining unnecessary machine details.
