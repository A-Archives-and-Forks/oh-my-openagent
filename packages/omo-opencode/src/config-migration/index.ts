export {
  CONFIG_JSONC_MIGRATION_ID,
  OPENCODE_CONFIG_MIGRATION_ID,
  discoverLegacyConfigGroups,
} from "./discovery"
export { transformConfigJsoncSources } from "./transform-config-jsonc"
export { transformOpenCodeSources } from "./transform-opencode"
export type {
  ConfigMigrationTransformResult,
  LoadedLegacyConfigSource,
  OpenCodeTransformScope,
  TransformConfigJsoncSourcesInput,
  TransformOpenCodeSourcesInput,
} from "./transform-types"
export type {
  ConfigMigrationDiscoveryFileSystem,
  ConfigMigrationDiscoveryOptions,
  ConfigMigrationPathOperations,
  DiscoveredLegacyConfigSource,
  LegacyConfigMigrationGroup,
  LegacyConfigSourceKind,
} from "./types"
