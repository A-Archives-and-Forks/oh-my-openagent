# Corrected postinstall oracle

Environment: npm 11.17.0, macOS arm64. Exact package: omo-ai@5.0.0-0.beta.79.
No real HOME, user/global npm configuration, or credential store was used.

Commands (both exited 0):

```bash
env -i PATH="$PATH" HOME=/tmp/omo-pr8538-npm/home-normal \
  npm install --prefix /tmp/omo-pr8538-npm/normal \
  --userconfig /tmp/omo-pr8538-npm/user.npmrc \
  --globalconfig /tmp/omo-pr8538-npm/global.npmrc \
  --cache /tmp/omo-pr8538-npm/cache --foreground-scripts omo-ai@5.0.0-0.beta.79

env -i PATH="$PATH" HOME=/tmp/omo-pr8538-npm/home-ignored \
  npm install --prefix /tmp/omo-pr8538-npm/ignored \
  --userconfig /tmp/omo-pr8538-npm/user.npmrc \
  --globalconfig /tmp/omo-pr8538-npm/global.npmrc \
  --cache /tmp/omo-pr8538-npm/cache-ignored --ignore-scripts omo-ai@5.0.0-0.beta.79
```

The two npmrc files contain comments only. Both HOME directories were empty.

| Observation | Normal install | --ignore-scripts |
| --- | --- | --- |
| omo-ai lifecycle command printed | node bin/senpi-patch.mjs | No |
| allow-scripts warning | Yes | No |
| RPC invalid_stream_event guard | Present, rpc-mode.js:111 | Absent |
| claudeCodeVersion | 2.1.251 | 2.1.251 |

The relevant RPC file is
`node_modules/@code-yeongyu/senpi/dist/modes/rpc/rpc-mode.js` under each prefix.
The API version file is
`node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`.

Conclusion: the warning did not block the lifecycle in this tested configuration.
The RPC guard provides the positive/negative oracle; the version string does not.
Other npm versions and explicit approval policies are not covered by this receipt.
