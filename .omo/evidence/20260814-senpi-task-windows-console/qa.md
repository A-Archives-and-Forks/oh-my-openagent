# Windows RPC child console QA

## Automated checks

- `bun test packages/senpi-task/src/runners`
  - Result: 115 passed, 3 skipped, 0 failed.
- `bun run --cwd packages/senpi-task typecheck`
  - Result: exit 0.
- `bun run --cwd packages/omo-senpi typecheck`
  - Result: exit 0.
- `bun run test:senpi`
  - Result: GitHub Actions `senpi-compatibility` passed on Windows, Ubuntu, and macOS.
  - Windows: https://github.com/code-yeongyu/oh-my-openagent/actions/runs/31767086674/job/94665147703
  - Ubuntu: https://github.com/code-yeongyu/oh-my-openagent/actions/runs/31767086674/job/94665147696
  - macOS: https://github.com/code-yeongyu/oh-my-openagent/actions/runs/31767086674/job/94665147645
  - This gate rebuilt and staged the plugin artifacts before running the Senpi adapter tests.
- Loaded `packages/omo-senpi/plugin/extensions/omo-task.js` with Node ESM.
  - Result: `omo-task-bundle-load-ok`.

## Windows process probe

The probe launched the real `RpcProcessRunner` default child path from a detached,
console-less parent and compared otherwise identical child processes.

- `windowsHide: false`: a visible top-level console window was detected.
- Current default spawn path (`windowsHide: true`): no visible top-level window;
  `MainWindowHandle` was `0`.
- The real Senpi RPC child also had no visible top-level window.
- stdin, stdout, and stderr pipes remained functional.
- `shell: false` preserved argv metacharacters without an intermediate `cmd.exe`.
- Termination completed without orphaned child processes.

Temporary probe files and processes were removed after verification.
