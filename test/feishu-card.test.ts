/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { status_card } from "../src/app/text.ts"
import { buildCard, sanitizeMarkdown } from "../src/feishu/api.ts"
import { createRender } from "../src/render/text.ts"

type CardElement = Record<string, unknown>

function elements(out: unknown): CardElement[] {
  const body = out && typeof out === "object" ? (out as { body?: { elements?: unknown } }).body : undefined
  return Array.isArray(body?.elements) ? (body.elements as CardElement[]) : []
}

function buttonByName(list: CardElement[], name: string) {
  return list.find((item) => item.tag === "button" && item.name === name)
}

function callbackValue(item: CardElement | undefined) {
  const behaviors = Array.isArray(item?.behaviors) ? (item.behaviors as Array<Record<string, unknown>>) : []
  const first = behaviors[0]
  return first && typeof first.value === "object" ? (first.value as Record<string, unknown>) : undefined
}

describe("feishu card rendering", () => {
  test("renders status card as schema 2.0 markdown content with escaped dynamic text", () => {
    const out = buildCard({
      title: "OpenCode",
      step: "处理中 *now*",
      text: "**粗体**\n- item\n`code`\n# title\n1. first",
    }) as Record<string, unknown>

    expect(out.schema).toBe("2.0")
    expect(elements(out)[0]).toEqual({
      tag: "markdown",
      content: "**处理中 \\*now\\***",
    })
    expect(elements(out)[1]).toEqual({
      tag: "markdown",
      content: "\\*\\*粗体\\*\\*\n\\- item\n\\`code\\`\n\\# title\n1\\. first",
    })
  })

  test("status_card keeps dynamic status content inert on the markdown serializer path", () => {
    const card = status_card({
      row: {
        status: "waiting_attachment",
        note: ["**bold**", "- item", '`<at id="@all"></at>`', "[repo](https://evil.example)"].join("\n"),
        updated_at: 1710000000000,
      },
      current: null,
      pref: { chat: null, user: null },
      conf: {
        log: { level: "info" },
        storage: { path: ":memory:" },
        feishu: { mode: "off" },
        opencode: {
          base_url: "http://127.0.0.1:4096",
          username: "opencode",
          directory: "/tmp/work",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
      },
    } as Parameters<typeof status_card>[0])
    const out = buildCard(card) as Record<string, unknown>
    const content = String(elements(out)[0]?.content ?? "")

    expect(card.textFormat).toBe("markdown")
    expect(out.schema).toBe("2.0")
    expect(elements(out)[0]).toMatchObject({
      tag: "markdown",
    })
    expect(content).toContain("\\*\\*bold\\*\\*")
    expect(content).toContain("\\- item")
    expect(content).toContain("\\`@all\\`")
    expect(content).toContain("repo（https\\[:\\]//evil.example）")
    expect(content).not.toContain("<at")
    expect(content).not.toContain("[repo](https://evil.example)")
  })

  test("status_card preserves completed progress markdown while keeping other status lines inert", () => {
    const card = status_card({
      row: {
        status: "completed",
        note: ["**So Far**", "- shipped", '`code`'].join("\n"),
        updated_at: 1710000000000,
      },
      current: {
        session_id: "ses_1",
        directory: "/tmp/work",
        workspace_id: "wrk_done",
        state: "active",
      },
      pref: { chat: null, user: null },
      conf: {
        log: { level: "info" },
        storage: { path: ":memory:" },
        feishu: { mode: "off" },
        opencode: {
          base_url: "http://127.0.0.1:4096",
          username: "opencode",
          directory: "/tmp/work",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
      },
    } as Parameters<typeof status_card>[0])
    const out = buildCard(card) as Record<string, unknown>
    const content = String(elements(out)[0]?.content ?? "")

    expect(card.textFormat).toBe("markdown")
    expect(out.schema).toBe("2.0")
    expect(content).toContain("目录：/tmp/work \\(workspace=wrk\\_done\\)")
    expect(content).toContain("session: ses\\_1")
    expect(content).toContain("最近进展：\n\n**So Far**\n- shipped\n`code`")
    expect(content).not.toContain("最近进展：\\n\\n\\*\\*So Far\\*\\*")
    expect(content).not.toContain("最近进展：\\*\\*So Far\\*\\*")
  })

  test("renders assistant final markdown as rich text without escaping supported syntax", () => {
    const render = createRender()
    const text = [
      "**上海 5/18-5/24**",
      "",
      "| 日期 | 天气 | 气温 |",
      "|---|---|---|",
      "| 5/18 | 阴天 | `20-29C` |",
    ].join("\n")
    const out = buildCard(render.final({ text }).body) as Record<string, unknown>
    const intermediate = buildCard(render.intermediate({ text }).body) as Record<string, unknown>

    expect(out.schema).toBe("2.0")
    expect(elements(out)[0]).toEqual({
      tag: "markdown",
      content: text,
    })
    expect(elements(intermediate)[0]).toEqual({
      tag: "markdown",
      content: text,
    })
  })

  test("strips Feishu-active syntax from assistant markdown while preserving formatting", () => {
    const render = createRender()
    const out = buildCard(
      render.final({
        text: [
          "**保留粗体** 和 `inline code`",
          "<at id=all></at>",
          "<a href=\"https://evil.example\">钓鱼链接</a>",
          "[普通链接](https://example.com)",
          "![tenant asset](img_v2_secret)",
        ].join("\n"),
      }).body,
    ) as Record<string, unknown>

    expect(elements(out)[0]).toEqual({
      tag: "markdown",
      content: [
        "**保留粗体** 和 `inline code`",
        "@all",
        "钓鱼链接（https[:]//evil.example）",
        "普通链接（https[:]//example.com）",
        "图片（tenant asset）：img_v2_secret",
      ].join("\n"),
    })
  })

  test("sanitizes active markdown outside code and handles edge cases", () => {
    const input = [
      "`[literal](https://example.com)`",
      "```",
      "<at id=all></at>",
      "[literal](https://example.com)",
      "```",
      '<img data-src="wrong" src="right" alt="a">',
      '<a data-href="wrong" href="https://right.example">x</a>',
      '<at id="ou_1">@张三</at>',
      '<at id="@all"></at>',
      "<https://evil.example>",
      "<foo@example.com>",
      "[ref][r]",
      "[a [b]](https://evil.example)",
      "[a [b [c]]](https://deeper.example/path_(x))",
      "![asset][i]",
      "![a [b]](img_v2_secret)",
      "![a [b [c]]](img_v2_deep)",
      "\\![literal asset][i]",
      "[r]: https://ref.example",
      "[r [x [y]]]: https://deep-ref.example/path_(x)",
      "[i]: img_v2_ref",
      "[deep [img]]: img_v2_ref_deep",
      '<number_tag url="https://evil.example">7</number_tag>',
      '<local_datetime timestamp="1" link="https://evil.example">',
      '<audio\n src="https://evil.example/x.mp3">play</audio>',
    ].join("\n")

    expect(sanitizeMarkdown(input)).toBe(
      [
        "`[literal](https://example.com)`",
        "```",
        "<at id=all></at>",
        "[literal](https://example.com)",
        "```",
        "图片（a）：right",
        "x（https[:]//right.example）",
        "@张三",
        "@all",
        "https[:]//evil.example",
        "foo[at]example.com",
        "ref",
        "a [b]（https[:]//evil.example）",
        "a [b [c]]（https[:]//deeper.example/path_(x)）",
        "图片（asset）",
        "图片（a [b]）：img_v2_secret",
        "图片（a [b [c]]）：img_v2_deep",
        "\\![literal asset][i]",
        "r：https[:]//ref.example",
        "r [x [y]]：https[:]//deep-ref.example/path_(x)",
        "i：img_v2_ref",
        "deep [img]：img_v2_ref_deep",
        "7",
        "",
        "play",
      ].join("\n"),
    )
  })

  test("recursively neutralizes nested markdown inside balanced labels and alt text", () => {
    expect(sanitizeMarkdown("[outer [inner](https://evil2.example)](https://evil1.example)")).toBe(
      "outer inner（https[:]//evil2.example）（https[:]//evil1.example）",
    )
    expect(sanitizeMarkdown("![outer ![img](img_v2_inner)](img_v2_outer)")).toBe(
      "图片（outer 图片（img）：img_v2_inner）：img_v2_outer",
    )
    expect(sanitizeMarkdown("[outer [inner](https://evil2.example)][r]\n[r]: https://evil1.example")).toBe(
      "outer inner（https[:]//evil2.example）\nr：https[:]//evil1.example",
    )
    expect(sanitizeMarkdown("![outer ![img](img_v2_inner)][i]\n[i]: img_v2_outer")).toBe(
      "图片（outer 图片（img）：img_v2_inner）\ni：img_v2_outer",
    )
  })

  test("keeps active syntax inert in escaped status and approval content even inside code syntax", () => {
    const status = buildCard({
      title: "OpenCode",
      text: [
        '`<at id="@all"></at>`',
        "```",
        '<a\n href="https://evil.example">x</a>',
        "```",
      ].join("\n"),
    }) as Record<string, unknown>
    const approval = buildCard({
      type: "approval",
      req: "req_active_in_code",
      tool: '`<person id="@user"/>`',
      detail: [
        "```",
        '<a\n href="https://evil.example">x</a>',
        "```",
      ].join("\n"),
    }) as Record<string, unknown>

    const statusText = String(elements(status)[0]?.content ?? "")
    const approvalText = String(elements(approval)[0]?.content ?? "")
    const approvalDetail = String(elements(approval)[1]?.content ?? "")

    expect(statusText).toContain("\\`@all\\`")
    expect(statusText).toContain("x（https\\[:\\]//evil.example）")
    expect(statusText).not.toContain("<at")
    expect(statusText).not.toContain("<a")

    expect(approvalText).toContain("**工具:** \\`@user\\`")
    expect(approvalText).not.toContain("<person")
    expect(approvalDetail).toContain("x（https\\[:\\]//evil.example）")
    expect(approvalDetail).not.toContain("<a")
  })

  test("keeps nested active markdown inert in escaped status content", () => {
    const status = buildCard({
      title: "OpenCode",
      text: "[outer [inner](https://evil2.example)](https://evil1.example)",
    }) as Record<string, unknown>

    expect(elements(status)[0]).toEqual({
      tag: "markdown",
      content: "outer inner（https\\[:\\]//evil2.example）（https\\[:\\]//evil1.example）",
    })
  })

  test("renders approval card with callback actions and escaped dynamic markdown", () => {
    const approval = buildCard({
      type: "approval",
      req: "req_approval_1",
      tool: "external_directory *danger*",
      detail: "`/tmp`\n- keep out",
    }) as Record<string, unknown>

    const approvalElements = elements(approval)
    const once = buttonByName(approvalElements, "approval_once")
    const always = buttonByName(approvalElements, "approval_always")
    const reject = buttonByName(approvalElements, "approval_reject")

    expect(approval.schema).toBe("2.0")
    expect(approvalElements[0]).toEqual({
      tag: "markdown",
      content: "**工具:** external\\_directory \\*danger\\*",
    })
    expect(approvalElements[1]).toEqual({
      tag: "markdown",
      content: "\\`/tmp\\`\n\\- keep out",
    })
    expect(approvalElements[2]).toEqual({
      tag: "markdown",
      content: "请直接点击下方按钮继续；如需更正本次操作，请直接发送非数字文本说明。",
    })
    expect(once).toMatchObject({
      tag: "button",
      name: "approval_once",
      type: "primary_filled",
      text: { tag: "plain_text", content: "允许一次" },
    })
    expect(always).toMatchObject({
      tag: "button",
      name: "approval_always",
      type: "default",
      text: { tag: "plain_text", content: "始终允许" },
    })
    expect(reject).toMatchObject({
      tag: "button",
      name: "approval_reject",
      type: "danger_filled",
      text: { tag: "plain_text", content: "拒绝" },
    })
    expect(callbackValue(once)).toEqual({
      req: "req_approval_1",
      kind: "approval",
      req_type: "permission",
      choice: "once",
    })
    expect(callbackValue(always)).toEqual({
      req: "req_approval_1",
      kind: "approval",
      req_type: "permission",
      choice: "always",
    })
    expect(callbackValue(reject)).toEqual({
      req: "req_approval_1",
      kind: "approval",
      req_type: "permission",
      choice: "reject",
    })
  })

  test("renders question card with multi-select form submit and text fallback guidance", () => {
    const question = buildCard({
      type: "question",
      title: "请补充信息",
      req: "req_question_1",
      options: ["A", "B"],
      custom: true,
    }) as Record<string, unknown>

    const questionElements = elements(question)
    const form = questionElements[1] as {
      tag?: string
      name?: string
      elements?: Array<Record<string, unknown>>
    }
    const multiSelect = Array.isArray(form.elements)
      ? form.elements.find((item) => item.tag === "multi_select_static")
      : undefined
    const submit = Array.isArray(form.elements)
      ? form.elements.find((item) => item.tag === "button" && item.name === "submit_question")
      : undefined

    expect(question.schema).toBe("2.0")
    expect(questionElements[0]).toEqual({
      tag: "markdown",
      content: "请在卡片中选择后提交；如需自定义补充，请直接发送非数字文本。",
    })
    expect(form).toMatchObject({
      tag: "form",
      name: "question_form",
    })
    expect(multiSelect).toEqual({
      tag: "multi_select_static",
      name: "choices",
      required: true,
      width: "fill",
      placeholder: { tag: "plain_text", content: "请选择一个或多个选项" },
      selected_values: [],
      options: [
        { text: { tag: "plain_text", content: "A" }, value: "A" },
        { text: { tag: "plain_text", content: "B" }, value: "B" },
      ],
    })
    expect(submit).toMatchObject({
      tag: "button",
      name: "submit_question",
      form_action_type: "submit",
      type: "primary_filled",
      text: { tag: "plain_text", content: "提交选择" },
    })
    expect(callbackValue(submit)).toEqual({
      req: "req_question_1",
      kind: "question",
      req_type: "question",
      choices_field: "choices",
    })
  })

  test("renders question card without form when no options are available", () => {
    const question = buildCard({
      type: "question",
      title: "请补充信息",
      req: "req_question_empty",
      options: [],
      custom: true,
    }) as Record<string, unknown>

    expect(question.schema).toBe("2.0")
    expect(elements(question)).toEqual([
      {
        tag: "markdown",
        content: "请直接发送你的回答继续。",
      },
    ])
  })

  test("sanitizes remote markdown images into plain text labels", () => {
    expect(sanitizeMarkdown("![thumb](https://via.placeholder.com/120x60)")).toBe("图片（thumb）：https://via.placeholder.com/120x60")
    expect(sanitizeMarkdown('<img src="https://via.placeholder.com/120x60" alt="demo" />')).toBe(
      "图片（demo）：https://via.placeholder.com/120x60",
    )

    const out = buildCard({
      title: "OpenCode",
      text: "见图：![thumb](https://via.placeholder.com/120x60)",
    }) as Record<string, unknown>

    expect(String(elements(out)[0]?.content ?? elements(out)[1]?.content)).not.toContain("![thumb](")
    expect(JSON.stringify(out)).not.toContain('"image_key":"https://via.placeholder.com/120x60"')
  })

  test("keeps image sanitization coverage while escaping dynamic markdown around labels", () => {
    const approval = buildCard({
      type: "approval",
      tool: "![alt](https://via.placeholder.com/120x60)",
      detail: '<img src="https://via.placeholder.com/120x60" alt="demo" />',
    }) as Record<string, unknown>

    const approvalElements = elements(approval)

    expect(approvalElements[0]).toEqual({
      tag: "markdown",
      content: "**工具:** 图片（alt）：https://via.placeholder.com/120x60",
    })
    expect(approvalElements[1]).toEqual({
      tag: "markdown",
      content: "图片（demo）：https://via.placeholder.com/120x60",
    })
  })
})
