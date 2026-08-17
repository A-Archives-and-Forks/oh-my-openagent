/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const publishWorkflowPath = new URL("../.github/workflows/publish.yml", import.meta.url)

function sliceWorkflowSection(workflow: string, startMarker: string, endMarker: string): string {
  const start = workflow.indexOf(startMarker)
  const end = workflow.indexOf(endMarker, start)
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`missing workflow section between ${startMarker} and ${endMarker}`)
  }
  return workflow.slice(start, end)
}

function sliceWorkflowSectionToEnd(workflow: string, startMarker: string): string {
  const start = workflow.indexOf(startMarker)
  if (start < 0) throw new Error(`missing workflow section starting at ${startMarker}`)
  return workflow.slice(start)
}

describe("publish gate reuse", () => {
  test("waits for a successful CI push workflow run on the exact prepared SHA", () => {
    const workflow = readFileSync(publishWorkflowPath, "utf8")
    const gateReuseJob = sliceWorkflowSection(workflow, "  gate-reuse:", "  preflight-trust:")

    expect(gateReuseJob).toContain("actions: read")
    expect(gateReuseJob).toContain("PREPARED_RELEASE_SHA: ${{ inputs.prepared_release_sha }}")
    expect(gateReuseJob).toContain('if [ -z "$PREPARED_RELEASE_SHA" ]')
    expect(gateReuseJob).toContain("actions/workflows/ci.yml/runs")
    expect(gateReuseJob).toContain("head_sha")
    expect(gateReuseJob).toContain("event=push")
    expect(gateReuseJob).toContain('.head_sha == $sha')
    expect(gateReuseJob).toContain('.event == "push"')
    expect(gateReuseJob).toContain('.status == "completed"')
    expect(gateReuseJob).toContain('.conclusion == "success"')
    expect(gateReuseJob).toContain("retry_gh")
    expect(gateReuseJob).toContain("set -euo pipefail")
    expect(gateReuseJob).not.toContain("check-runs")
    expect(gateReuseJob).not.toContain("REQUIRED_CHECKS")
    expect(gateReuseJob).not.toContain("continue-on-error")
  })

  test("removes release-local test jobs and gates publication on CI reuse", () => {
    const workflow = readFileSync(publishWorkflowPath, "utf8")
    const prepareJob = sliceWorkflowSection(workflow, "  prepare-release-state:", "  dispatch-provenance-safe-publish:")
    const publishMainJob = sliceWorkflowSection(workflow, "  publish-main:", "  publish-platform:")
    const publishPlatformJob = sliceWorkflowSection(workflow, "  publish-platform:", "  release:")

    expect(workflow).not.toContain("\n  test:\n")
    expect(workflow).not.toContain("\n  typecheck:\n")
    expect(workflow).not.toContain("\n  codex-compatibility:\n")
    for (const job of [prepareJob, publishMainJob, publishPlatformJob]) {
      expect(job).toContain("gate-reuse")
      expect(job).toContain("needs.gate-reuse.result == 'success'")
      expect(job).not.toContain("needs.test")
      expect(job).not.toContain("needs.typecheck")
      expect(job).not.toContain("needs.codex-compatibility")
    }
  })

  test("uses a workflow-capable token and retries release PR writes", () => {
    const workflow = readFileSync(publishWorkflowPath, "utf8")
    const prepareJob = sliceWorkflowSection(workflow, "  prepare-release-state:", "  dispatch-provenance-safe-publish:")

    expect(prepareJob).toContain("token: ${{ secrets.GH_PAT }}")
    expect(prepareJob).toContain("GH_TOKEN: ${{ secrets.GH_PAT }}")
    expect(prepareJob).toContain("create_release_pr()")
    expect(prepareJob).toContain("enable_release_auto_merge()")
    expect(prepareJob).toContain("gh pr create")
    expect(prepareJob).toContain("gh pr merge")
    expect(prepareJob).toContain('retry_gh "Read release-state PR state" gh pr view')
    expect(prepareJob).toContain('retry_gh "Read release-state PR checks" gh pr view')
  })

  test("keeps every publication surface pinned to a prepared release SHA", () => {
    const workflow = readFileSync(publishWorkflowPath, "utf8")
    const publishMainJob = sliceWorkflowSection(workflow, "  publish-main:", "  publish-platform:")
    const publishPlatformJob = sliceWorkflowSection(workflow, "  publish-platform:", "  release:")
    const releaseJob = sliceWorkflowSectionToEnd(workflow, "  release:")

    expect(publishMainJob).toContain("inputs.prepared_release_sha != ''")
    expect(publishPlatformJob).toContain("inputs.prepared_release_sha != ''")
    expect(releaseJob).toContain("inputs.prepared_release_sha != ''")
  })
})
