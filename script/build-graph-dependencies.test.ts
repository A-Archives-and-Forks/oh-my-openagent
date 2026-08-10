import { join } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { API } from "typescript/unstable/async"
import * as ts from "typescript/unstable/ast"

type BuildGraph = ReadonlyMap<string, readonly string[]>

const repoRoot = join(import.meta.dir, "..")
const buildPath = join(import.meta.dir, "build.ts")
const parser = new API({ cwd: repoRoot })

afterAll(async () => {
  await parser.close()
})

describe("build graph resource ownership", () => {
  test("#given Codex and Senpi plugin builds #when graph dependencies are audited #then Codex provisions the shared plugin tree first", async () => {
    // given
    const sourceFile = await parseBuildSource()

    // when
    const graph = readBuildGraph(sourceFile)

    // then
    expect(graph.get("senpi-plugin")).toContain("codex-plugin")
  })
})

async function parseBuildSource(): Promise<ts.SourceFile> {
  const snapshot = await parser.updateSnapshot({ openFiles: [buildPath] })
  try {
    const project = await snapshot.getDefaultProjectForFile(buildPath)
    const sourceFile = await project?.program.getSourceFile(buildPath)
    if (sourceFile === undefined) throw new Error("TypeScript did not parse script/build.ts")
    return sourceFile
  } finally {
    await snapshot.dispose()
  }
}

function readBuildGraph(sourceFile: ts.SourceFile): BuildGraph {
  const nodes = findBuildNodes(sourceFile)
  const graph = new Map<string, readonly string[]>()

  for (const element of nodes.elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      throw new Error(`Expected every build node to be an object literal, received ${element.getText(sourceFile)}`)
    }

    const id = readStringProperty(element, "id", sourceFile)
    const deps = readStringArrayProperty(element, "deps", sourceFile)
    graph.set(id, deps)
  }

  return graph
}

function findBuildNodes(sourceFile: ts.SourceFile): ts.ArrayLiteralExpression {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name)
        && declaration.name.text === "nodes"
        && declaration.initializer !== undefined
        && ts.isArrayLiteralExpression(declaration.initializer)
      ) {
        return declaration.initializer
      }
    }
  }

  throw new Error("Expected script/build.ts to declare a nodes array")
}

function readStringProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
  sourceFile: ts.SourceFile,
): string {
  const initializer = readPropertyInitializer(object, propertyName)
  if (!ts.isStringLiteral(initializer)) {
    throw new Error(`Expected ${propertyName} to be a string literal, received ${initializer.getText(sourceFile)}`)
  }
  return initializer.text
}

function readStringArrayProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
  sourceFile: ts.SourceFile,
): readonly string[] {
  const initializer = readPropertyInitializer(object, propertyName)
  if (!ts.isArrayLiteralExpression(initializer)) {
    throw new Error(`Expected ${propertyName} to be an array literal, received ${initializer.getText(sourceFile)}`)
  }
  return initializer.elements.map((element) => {
    if (!ts.isStringLiteral(element)) {
      throw new Error(`Expected ${propertyName} entries to be string literals, received ${element.getText(sourceFile)}`)
    }
    return element.text
  })
}

function readPropertyInitializer(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.Expression {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate)
      && ts.isIdentifier(candidate.name)
      && candidate.name.text === propertyName,
  )
  if (property === undefined) throw new Error(`Expected build node to define ${propertyName}`)
  return property.initializer
}
