export interface SkillSource {
  name: string
  source: string
  sharedAssets?: string[]
}
export function createNativeSkillSources(repoRoot: string): { sources: SkillSource[]; names: Set<string> }
