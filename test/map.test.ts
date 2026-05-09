import { describe, expect, test } from "bun:test"
import { parseCardAction, parseMessage } from "../src/feishu/map.ts"

describe("parseMessage", () => {
  test("parses rich post text, images, files, and mentions", () => {
    const msg = parseMessage({
      event_id: "evt_1",
      tenant_key: "tenant",
      message: {
        chat_id: "chat_1",
        message_id: "msg_1",
        root_id: "root_1",
        parent_id: "parent_1",
        chat_type: "group",
        message_type: "post",
        content: JSON.stringify({
          zh_cn: {
            title: "测试标题",
            content: [
              [
                { tag: "text", text: "第一行" },
                { tag: "img", image_key: "img_1" },
              ],
              [
                { tag: "file", file_key: "file_1", file_name: "demo.pdf" },
              ],
            ],
          },
        }),
        mentions: [
          {
            name: "飞书 CLI",
            id: { open_id: "ou_bot" },
          },
        ],
      },
      sender: {
        sender_id: {
          open_id: "ou_user",
        },
      },
    })

    expect(msg).toMatchObject({
      tenant_id: "tenant",
      chat_id: "chat_1",
      user_id: "ou_user",
      thread_id: "root_1",
      root_message_id: "root_1",
      text: "测试标题\n第一行",
      mentions: ["ou_bot"],
      mention_names: ["飞书 CLI"],
    })
    expect(msg?.assets).toEqual([
      { kind: "image", key: "img_1", name: "image-img_1.png" },
      { kind: "file", key: "file_1", name: "demo.pdf" },
    ])
  })

  test("parses plain text with multiple image keys and file key", () => {
    const msg = parseMessage({
      message: {
        chat_id: "chat_2",
        message_id: "msg_2",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({
          text: "看看这些附件",
          image_keys: ["img_a", "img_b"],
          file_key: "file_a",
          file_name: "note.txt",
        }),
      },
      sender: {
        sender_id: {
          open_id: "ou_user",
        },
      },
    })

    expect(msg).toMatchObject({
      chat_id: "chat_2",
      text: "看看这些附件",
    })
    expect(msg?.assets).toEqual([
      { kind: "image", key: "img_a", name: "image-img_a.png" },
      { kind: "image", key: "img_b", name: "image-img_b.png" },
      { kind: "file", key: "file_a", name: "note.txt" },
    ])
  })

  test("parses mixed post with multiple images, file, and plain text lines", () => {
    const msg = parseMessage({
      event_id: "evt_2",
      tenant_key: "tenant",
      message: {
        chat_id: "chat_3",
        message_id: "msg_3",
        chat_type: "p2p",
        thread_id: "thr_1",
        message_type: "post",
        content: JSON.stringify({
          zh_cn: {
            title: "需求说明",
            content: [
              [
                { tag: "text", text: "先看这两张图" },
                { tag: "img", image_key: "img_1" },
                { tag: "img", image_key: "img_2" },
              ],
              [
                { tag: "text", text: "再参考附件" },
                { tag: "file", file_key: "file_1", file_name: "spec.pdf" },
              ],
            ],
          },
        }),
      },
      sender: {
        sender_id: {
          open_id: "ou_user",
        },
      },
    })

    expect(msg).toMatchObject({
      chat_id: "chat_3",
      thread_id: "thr_1",
      text: "需求说明\n先看这两张图\n再参考附件",
    })
    expect(msg?.assets).toEqual([
      { kind: "image", key: "img_1", name: "image-img_1.png" },
      { kind: "image", key: "img_2", name: "image-img_2.png" },
      { kind: "file", key: "file_1", name: "spec.pdf" },
    ])
  })
})

describe("parseCardAction", () => {
  test("parses approval callback into normalized inbound action", () => {
    const event = parseCardAction({
      event_id: "evt_card_1",
      tenant_key: "tenant",
      token: "tok_1",
      open_message_id: "om_1",
      operator: {
        operator_id: {
          open_id: "ou_user",
        },
      },
      context: {
        open_chat_id: "oc_1",
        open_message_id: "om_1",
      },
      action: {
        value: {
          action: "approval",
          req: "req_1",
          reply: "always",
        },
      },
    })

    expect(event).toMatchObject({
      kind: "card_action",
      action: "approval",
      event_id: "evt_card_1",
      tenant_id: "tenant",
      chat_id: "oc_1",
      user_id: "ou_user",
      message_id: "om_1",
      req: "req_1",
      reply: "always",
    })
  })

  test("parses question callback answers from action values", () => {
    const event = parseCardAction({
      tenant_key: "tenant",
      token: "tok_2",
      context: {
        open_chat_id: "oc_2",
        open_message_id: "om_2",
      },
      operator: {
        operator_id: {
          open_id: "ou_user",
        },
      },
      action: {
        value: {
          action: "question",
          req: "req_2",
          answers: [["A", "B"]],
        },
      },
    })

    expect(event).toMatchObject({
      kind: "card_action",
      action: "question",
      chat_id: "oc_2",
      user_id: "ou_user",
      message_id: "om_2",
      req: "req_2",
      answers: [["A", "B"]],
    })
    expect(event?.event_id).toContain("tok_2")
    expect(event?.event_id).toContain("req_2")
  })

  test("parses question callback answers from submitted form values", () => {
    const event = parseCardAction({
      tenant_key: "tenant",
      token: "tok_2_form",
      context: {
        open_chat_id: "oc_2_form",
        open_message_id: "om_2_form",
      },
      operator: {
        operator_id: {
          open_id: "ou_user",
        },
      },
      action: {
        value: {
          kind: "question",
          req: "req_2_form",
          choices_field: "choices",
        },
        form_value: {
          req: "req_should_not_become_answer",
          kind: "question",
          choices: ["A", "B"],
        },
      },
    })

    expect(event).toMatchObject({
      kind: "card_action",
      action: "question",
      chat_id: "oc_2_form",
      user_id: "ou_user",
      message_id: "om_2_form",
      req: "req_2_form",
      answers: [["A", "B"]],
    })
  })

  test("prefers structured answers over fallback question fields", () => {
    const event = parseCardAction({
      tenant_key: "tenant",
      token: "tok_2_priority",
      context: {
        open_chat_id: "oc_2_priority",
        open_message_id: "om_2_priority",
      },
      operator: {
        operator_id: {
          open_id: "ou_user",
        },
      },
      action: {
        value: {
          kind: "question",
          req: "req_2_priority",
          answers: [["A"]],
          text: "free text should lose",
          option: "B",
        },
        form_value: {
          choices: ["C", "D"],
        },
      },
    })

    expect(event).toMatchObject({
      kind: "card_action",
      action: "question",
      chat_id: "oc_2_priority",
      user_id: "ou_user",
      message_id: "om_2_priority",
      req: "req_2_priority",
      answers: [["A"]],
    })
  })

  test("parses official header-event envelope shape", () => {
    const event = parseCardAction({
      schema: "2.0",
      header: {
        event_id: "evt_card_3",
        tenant_key: "tenant_hdr",
        token: "verify_token",
        event_type: "card.action.trigger",
      },
      event: {
        token: "card_token",
        operator: {
          open_id: "ou_user",
        },
        context: {
          open_chat_id: "oc_3",
          open_message_id: "om_3",
        },
        action: {
          tag: "button",
          value: {
            action: "approval",
            req: "req_3",
            reply: "reject",
          },
        },
      },
    })

    expect(event).toMatchObject({
      kind: "card_action",
      action: "approval",
      event_id: "evt_card_3",
      tenant_id: "tenant_hdr",
      chat_id: "oc_3",
      message_id: "om_3",
      user_id: "ou_user",
      req: "req_3",
      reply: "reject",
    })
  })

  test("returns null when callback lacks actionable req or payload", () => {
    expect(
      parseCardAction({
        context: {
          open_chat_id: "oc_3",
        },
        operator: {
          operator_id: {
            open_id: "ou_user",
          },
        },
        action: {
          value: {
            action: "approval",
          },
        },
      }),
    ).toBeNull()
  })
})
