import { afterEach, describe, expect, test } from "bun:test"
import type { AppCfg } from "../src/contracts.ts"
import { createOpencodeSvc } from "../src/opencode/client.ts"

const fetch0 = globalThis.fetch

function cfg() {
  return {
    log: { level: "info" },
    storage: { path: ":memory:" },
    feishu: { mode: "off" },
    opencode: {
      base_url: "http://127.0.0.1:4096",
      username: "opencode",
      directory: "/tmp",
    },
  } satisfies AppCfg
}

afterEach(() => {
  globalThis.fetch = fetch0
})

describe("opencode client", () => {
  test("last picks the newest assistant message with text output", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            info: {
              role: "assistant",
            },
            parts: [
              {
                type: "text",
                text: "第一条有效回复",
                time: {
                  end: 1,
                },
              },
            ],
          },
          {
            info: {
              role: "assistant",
            },
            parts: [
              {
                type: "step-start",
              },
            ],
          },
          {
            info: {
              role: "assistant",
            },
            parts: [
              {
                type: "text",
                text: "最新有效回复",
                time: {
                  end: 2,
                },
              },
            ],
          },
          {
            info: {
              role: "assistant",
            },
            parts: [
              {
                type: "text",
                text: "",
                time: {
                  end: 3,
                },
              },
            ],
          },
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      )) as typeof fetch0

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.last({
        session_id: "ses_1",
      }),
    ).toBe("最新有效回复")
  })

  test("last ignores synthetic and ignored text parts", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            info: {
              role: "assistant",
            },
            parts: [
              {
                type: "text",
                text: 'Called the Read tool with the following input: {"filePath":"/tmp/a.png"}',
                synthetic: true,
                time: {
                  end: 1,
                },
              },
              {
                type: "text",
                text: "真正应该展示的回复",
                time: {
                  end: 2,
                },
              },
            ],
          },
          {
            info: {
              role: "assistant",
            },
            parts: [
              {
                type: "text",
                text: "只给模型自己看的补充",
                ignored: true,
                time: {
                  end: 3,
                },
              },
            ],
          },
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      )) as typeof fetch0

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.last({
        session_id: "ses_1",
      }),
    ).toBe("真正应该展示的回复")
  })

  test("last prefers completed assistant text over newer unfinished draft", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            info: {
              role: "assistant",
              time: {
                completed: 1,
              },
            },
            parts: [
              {
                type: "text",
                text: "真正的最终回复",
                time: {
                  end: 1,
                },
              },
            ],
          },
          {
            info: {
              role: "assistant",
            },
            parts: [
              {
                type: "text",
                text: "我先看看这个目录……",
                time: {
                  end: 2,
                },
              },
            ],
          },
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      )) as typeof fetch0

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.last({
        session_id: "ses_1",
      }),
    ).toBe("真正的最终回复")
  })

  test("last prefers healthy completed text over newer errored assistant text", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            info: {
              role: "assistant",
              time: {
                completed: 1,
              },
            },
            parts: [
              {
                type: "text",
                text: "稳定的最终答复",
                time: {
                  end: 1,
                },
              },
            ],
          },
          {
            info: {
              role: "assistant",
              time: {
                completed: 2,
              },
              error: {
                name: "APIError",
                message: "boom",
              },
            },
            parts: [
              {
                type: "text",
                text: "中途失败前留下的半成品",
                time: {
                  end: 2,
                },
              },
            ],
          },
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      )) as typeof fetch0

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.last({
        session_id: "ses_1",
      }),
    ).toBe("稳定的最终答复")
  })

  test("last ignores newer summary assistant text", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            info: {
              role: "assistant",
              time: {
                completed: 1,
              },
            },
            parts: [
              {
                type: "text",
                text: "真正发给用户的回复",
                time: {
                  end: 1,
                },
              },
            ],
          },
          {
            info: {
              role: "assistant",
              summary: true,
              time: {
                completed: 2,
              },
            },
            parts: [
              {
                type: "text",
                text: "系统内部总结，不该发到飞书",
                time: {
                  end: 2,
                },
              },
            ],
          },
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      )) as typeof fetch0

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.last({
        session_id: "ses_1",
      }),
    ).toBe("真正发给用户的回复")
  })

  test("result reports filtered when only hidden assistant text exists", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            info: {
              role: "assistant",
              summary: true,
              time: {
                completed: 1,
              },
            },
            parts: [
              {
                type: "text",
                text: "内部总结",
                time: {
                  end: 1,
                },
              },
            ],
          },
          {
            info: {
              role: "assistant",
              time: {
                completed: 2,
              },
            },
            parts: [
              {
                type: "text",
                text: "Called the Read tool",
                synthetic: true,
                time: {
                  end: 2,
                },
              },
            ],
          },
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      )) as typeof fetch0

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.result?.({
        session_id: "ses_1",
      }),
    ).toEqual({
      state: "filtered",
    })
  })
})
