import { describe, expect, test } from "bun:test"
import { parseMessage } from "../src/feishu/map.ts"

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
})
