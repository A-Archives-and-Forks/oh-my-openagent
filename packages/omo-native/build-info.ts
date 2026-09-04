/** Build provenance stamped into compiled dev binaries. */
export interface BuildComponentInfo {
	readonly commit: string
	readonly committedAt: string
	readonly branch: string
}

export interface OmoBuildInfo {
	readonly command: string
	readonly omo: BuildComponentInfo
	readonly engine: BuildComponentInfo
}

export function parseBuildInfo(raw: unknown): OmoBuildInfo | undefined {
	return undefined
}

export function shortSha(commit: string): string {
	return commit
}

export function buildLabel(info: OmoBuildInfo): string {
	return ""
}

export function versionLines(info: OmoBuildInfo): string[] {
	return []
}
