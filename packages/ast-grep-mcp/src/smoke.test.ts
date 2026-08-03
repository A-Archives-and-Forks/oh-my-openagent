import { describe, expect, it } from "bun:test";
import { AST_GREP_MCP_NAME } from "./index";

describe("ast-grep-mcp smoke", () => {
  it("exports the MCP server name constant", () => {
    // given: the barrel index module is importable
    // when: importing AST_GREP_MCP_NAME
    // then: it equals "ast_grep"
    expect(AST_GREP_MCP_NAME).toBe("ast_grep");
  });
});
