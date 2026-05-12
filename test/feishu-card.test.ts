/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { buildCard, sanitizeMarkdown } from "../src/feishu/api.ts"

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
  test("renders status card as schema 2.0 markdown content", () => {
    const out = buildCard({
      title: "OpenCode",
      step: "处理中",
      text: "**粗体**\n- item\n`code`",
    }) as Record<string, unknown>

    expect(out.schema).toBe("2.0")
    expect(elements(out)[0]).toEqual({
      tag: "markdown",
      content: "**处理中**",
    })
    expect(elements(out)[1]).toEqual({
      tag: "markdown",
      content: "**粗体**\n- item\n`code`",
    })
  })

  test("renders approval card with callback actions", () => {
    const approval = buildCard({
      type: "approval",
      req: "req_approval_1",
      tool: "external_directory",
      detail: "`/tmp`",
    }) as Record<string, unknown>

    const approvalElements = elements(approval)
    const once = buttonByName(approvalElements, "approval_once")
    const always = buttonByName(approvalElements, "approval_always")
    const reject = buttonByName(approvalElements, "approval_reject")

    expect(approval.schema).toBe("2.0")
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
})
