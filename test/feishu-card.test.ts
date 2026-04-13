import { describe, expect, test } from "bun:test"
import { buildCard, sanitizeMarkdown } from "../src/feishu/api.ts"

describe("feishu card rendering", () => {
  test("renders status card as schema 2.0 markdown content", () => {
    const out = buildCard({
      title: "OpenCode",
      step: "处理中",
      text: "**粗体**\n- item\n`code`",
    }) as Record<string, any>

    expect(out.schema).toBe("2.0")
    expect(out.body?.elements?.[0]).toEqual({
      tag: "markdown",
      content: "**处理中**",
    })
    expect(out.body?.elements?.[1]).toEqual({
      tag: "markdown",
      content: "**粗体**\n- item\n`code`",
    })
  })

  test("renders approval and question cards with markdown elements", () => {
    const approval = buildCard({
      type: "approval",
      tool: "external_directory",
      detail: "`/tmp`",
    }) as Record<string, any>
    const question = buildCard({
      type: "question",
      title: "请补充信息",
      options: ["A", "B"],
      custom: true,
    }) as Record<string, any>

    expect(approval.schema).toBe("2.0")
    expect(approval.body?.elements?.every((item: any) => item.tag === "markdown")).toBe(true)
    expect(question.schema).toBe("2.0")
    expect(question.body?.elements?.[0]?.tag).toBe("markdown")
    expect(question.body?.elements?.[0]?.content).toContain("1. A")
  })

  test("sanitizes remote markdown images into plain text labels", () => {
    expect(sanitizeMarkdown("![thumb](https://via.placeholder.com/120x60)")).toBe("图片（thumb）：https://via.placeholder.com/120x60")
    expect(sanitizeMarkdown('<img src="https://via.placeholder.com/120x60" alt="demo" />')).toBe(
      "图片（demo）：https://via.placeholder.com/120x60",
    )

    const out = buildCard({
      title: "OpenCode",
      text: "见图：![thumb](https://via.placeholder.com/120x60)",
    }) as Record<string, any>

    expect(out.body?.elements?.[0]?.content ?? out.body?.elements?.[1]?.content).not.toContain("![thumb](")
    expect(JSON.stringify(out)).not.toContain('"image_key":"https://via.placeholder.com/120x60"')
  })
})
