/// <reference types="bun-types" />
import crypto from "node:crypto"
import { afterEach, describe, expect, test } from "bun:test"
import type { AppCfg } from "../src/contracts.ts"
import { createOpencodeSvc } from "../src/opencode/client.ts"

const fetch0 = globalThis.fetch

function cfg(input?: Partial<AppCfg["opencode"]>) {
  return {
    log: { level: "info" },
    storage: { path: ":memory:" },
    feishu: { mode: "off" },
    opencode: {
      base_url: "http://127.0.0.1:4096",
      username: "opencode",
      directory: "/tmp",
      ...input,
    },
  } satisfies AppCfg
}

afterEach(() => {
  globalThis.fetch = fetch0
})

function hash(entries: string[]) {
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex")
}

function mock_fetch(data: unknown) {
  globalThis.fetch = Object.assign(
    async (..._args: Parameters<typeof fetch>) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    {
      preconnect: fetch0.preconnect.bind(fetch0),
    },
  )
}

function mock_metadata_fetch() {
  const urls: string[] = []
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      urls.push(url.toString())
      const body = url.pathname === "/provider" || url.pathname === "/mcp" ? {} : []
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    },
    {
      preconnect: fetch0.preconnect.bind(fetch0),
    },
  )
  return urls
}

function capture_fetch(body: unknown = {}) {
  const urls: string[] = []
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      urls.push(url.toString())
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    },
    {
      preconnect: fetch0.preconnect.bind(fetch0),
    },
  )
  return urls
}

describe("opencode client", () => {
  test("last picks the newest assistant message with text output", async () => {
    mock_fetch([
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
    ])

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.last({
        session_id: "ses_1",
      }),
    ).toBe("最新有效回复")
  })

  test("last ignores synthetic and ignored text parts", async () => {
    mock_fetch([
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
    ])

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.last({
        session_id: "ses_1",
      }),
    ).toBe("真正应该展示的回复")
  })

  test("last prefers completed assistant text over newer unfinished draft", async () => {
    mock_fetch([
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
    ])

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.last({
        session_id: "ses_1",
      }),
    ).toBe("真正的最终回复")
  })

  test("last prefers healthy completed text over newer errored assistant text", async () => {
    mock_fetch([
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
    ])

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.last({
        session_id: "ses_1",
      }),
    ).toBe("稳定的最终答复")
  })

  test("last ignores newer summary assistant text", async () => {
    mock_fetch([
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
    ])

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.last({
        session_id: "ses_1",
      }),
    ).toBe("真正发给用户的回复")
  })

  test("prompt omits configured default agent and model when caller does not provide them", async () => {
    const capture: { request?: { url: string; body: Record<string, unknown> | null } } = {}
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capture.request = {
          url: String(input),
          body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
      {
        preconnect: fetch0.preconnect.bind(fetch0),
      },
    )

    const svc = createOpencodeSvc(
      cfg({
        agent: "planner",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      }),
    )
    await svc.prompt({
      session_id: "ses_1",
      text: "hello",
      directory: "/tmp/alt",
    })

    const request = capture.request
    if (!request) throw new Error("expected prompt request")
    expect(request.url).toContain("/session/ses_1/prompt_async")
    const body = request.body
    if (!body) throw new Error("expected prompt request body")
    expect(body).toEqual({
      parts: [{ type: "text", text: "hello" }],
    })
  })

  test("prompt forwards explicit model override when caller provides it", async () => {
    const capture: { body?: Record<string, unknown> | null } = {}
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capture.body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
      {
        preconnect: fetch0.preconnect.bind(fetch0),
      },
    )

    const svc = createOpencodeSvc(
      cfg({
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      }),
    )
    await svc.prompt({
      session_id: "ses_1",
      text: "hello",
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
      },
    })

    const requestBody = capture.body
    if (!requestBody) throw new Error("expected prompt request body")
    expect(requestBody).toEqual({
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
      },
      parts: [{ type: "text", text: "hello" }],
    })
  })

  test("prompt forwards explicit model variant when caller provides it", async () => {
    const capture: { body?: Record<string, unknown> | null } = {}
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capture.body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
      {
        preconnect: fetch0.preconnect.bind(fetch0),
      },
    )

    const svc = createOpencodeSvc(cfg())
    await svc.prompt({
      session_id: "ses_1",
      text: "hello",
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variant: "thinking",
      },
    })

    const requestBody = capture.body
    if (!requestBody) throw new Error("expected prompt request body")
    expect(requestBody).toEqual({
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
      },
      variant: "thinking",
      parts: [{ type: "text", text: "hello" }],
    })
  })

  test("prompt forwards explicit agent override when caller provides it", async () => {
    const capture: { body?: Record<string, unknown> | null } = {}
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capture.body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
      {
        preconnect: fetch0.preconnect.bind(fetch0),
      },
    )

    const svc = createOpencodeSvc(cfg({ agent: "planner" }))
    await svc.prompt({
      session_id: "ses_1",
      text: "hello",
      agent: "researcher",
    })

    const requestBody = capture.body
    if (!requestBody) throw new Error("expected prompt request body")
    expect(requestBody).toEqual({
      agent: "researcher",
      parts: [{ type: "text", text: "hello" }],
    })
  })

  test("metadata endpoints use configured default scope", async () => {
    const urls = mock_metadata_fetch()
    const svc = createOpencodeSvc(
      cfg({
        directory: "/tmp/default-scope",
        workspace: "ws_default",
      }),
    )

    await svc.commands()
    await svc.skills()
    await svc.agents()
    await svc.providers()
    await svc.mcps()

    expect(
      urls.map((item) => {
        const url = new URL(item)
        return {
          path: url.pathname,
          directory: url.searchParams.get("directory"),
          workspace: url.searchParams.get("workspace"),
        }
      }),
    ).toEqual([
      { path: "/command", directory: "/tmp/default-scope", workspace: "ws_default" },
      { path: "/skill", directory: "/tmp/default-scope", workspace: "ws_default" },
      { path: "/agent", directory: "/tmp/default-scope", workspace: "ws_default" },
      { path: "/provider", directory: "/tmp/default-scope", workspace: "ws_default" },
      { path: "/mcp", directory: "/tmp/default-scope", workspace: "ws_default" },
    ])
  })

  test("metadata endpoints allow explicit scope override", async () => {
    const urls = mock_metadata_fetch()
    const svc = createOpencodeSvc(
      cfg({
        directory: "/tmp/default-scope",
        workspace: "ws_default",
      }),
    )

    const input = {
      directory: "/tmp/override-scope",
      workspace: "ws_override",
    }

    await svc.commands(input)
    await svc.skills(input)
    await svc.agents(input)
    await svc.providers(input)
    await svc.mcps(input)

    expect(
      urls.map((item) => {
        const url = new URL(item)
        return {
          path: url.pathname,
          directory: url.searchParams.get("directory"),
          workspace: url.searchParams.get("workspace"),
        }
      }),
    ).toEqual([
      { path: "/command", directory: "/tmp/override-scope", workspace: "ws_override" },
      { path: "/skill", directory: "/tmp/override-scope", workspace: "ws_override" },
      { path: "/agent", directory: "/tmp/override-scope", workspace: "ws_override" },
      { path: "/provider", directory: "/tmp/override-scope", workspace: "ws_override" },
      { path: "/mcp", directory: "/tmp/override-scope", workspace: "ws_override" },
    ])
  })

  test("ensure forwards nested model variant when caller provides it", async () => {
    const capture: { url?: string; body?: Record<string, unknown> | null } = {}
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capture.url = String(input)
        capture.body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
        return new Response(JSON.stringify({ id: "ses_new" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
      {
        preconnect: fetch0.preconnect.bind(fetch0),
      },
    )

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.ensure({
        directory: "/tmp/project",
        workspace: "ws_local",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
          variant: "fast",
        },
      }),
    ).toEqual({ id: "ses_new" })
    expect(capture.url).toContain('/session?directory=%2Ftmp%2Fproject&workspace=ws_local')
    expect(capture.body).toEqual({
      model: {
        id: "gpt-5.4",
        providerID: "openai",
        variant: "fast",
      },
    })
  })

  test("command forwards top-level variant and provider/model string", async () => {
    const capture: { url?: string; body?: Record<string, unknown> | null } = {}
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capture.url = String(input)
        capture.body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
      {
        preconnect: fetch0.preconnect.bind(fetch0),
      },
    )

    const svc = createOpencodeSvc(cfg())
    await svc.command({
      session_id: "ses_1",
      command: "init",
      arguments: "--quick",
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
        variant: "fast",
      },
    })

    expect(capture.url).toContain('/session/ses_1/command')
    expect(capture.body).toEqual({
      command: "init",
      arguments: "--quick",
      model: "openai/gpt-5.4",
      variant: "fast",
    })
  })

  test("session reads back model variant from payload", async () => {
    mock_fetch({
      id: "ses_1",
      title: "Session 1",
      directory: "/tmp/project",
      workspaceID: "ws_local",
      model: {
        providerID: "openai",
        id: "gpt-5.4",
        variant: "fast",
      },
      time: {
        created: 1,
        updated: 2,
      },
    })

    const svc = createOpencodeSvc(cfg())
    expect(await svc.session("ses_1")).toEqual({
      id: "ses_1",
      title: "Session 1",
      directory: "/tmp/project",
      workspace_id: "ws_local",
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
        variant: "fast",
      },
      created_at: 1,
      updated_at: 2,
    })
  })

  test("providers preserves model variants metadata", async () => {
    mock_fetch({
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5.4": {
              name: "GPT 5.4",
              variants: {
                slow: {},
                balanced: {},
                fast: {},
              },
            },
            "gpt-4.1": {
              name: "GPT 4.1",
              variants: {},
            },
            "gpt-4o": {
              name: "GPT 4o",
              variants: ["fast"],
            },
          },
        },
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "claude-sonnet-4": {
              name: "Claude Sonnet 4",
              variants: {
                thinking: {},
              },
            },
          },
        },
      ],
      connected: ["openai"],
      default: {
        openai: "gpt-5.4",
        anthropic: "claude-sonnet-4",
      },
    })

    const svc = createOpencodeSvc(cfg())

    expect(await svc.providers()).toEqual([
      {
        id: "openai",
        name: "OpenAI",
        connected: true,
        default_model: "gpt-5.4",
        models: [
          {
            id: "gpt-5.4",
            name: "GPT 5.4",
            variants: ["balanced", "fast", "slow"],
          },
          {
            id: "gpt-4.1",
            name: "GPT 4.1",
          },
          {
            id: "gpt-4o",
            name: "GPT 4o",
          },
        ],
      },
    ])
  })

  test("providers ignores malformed model collections", async () => {
    mock_fetch({
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: [
            {
              name: "GPT 5.4",
            },
          ],
        },
      ],
      connected: ["openai"],
      default: {
        openai: "gpt-5.4",
      },
    })

    const svc = createOpencodeSvc(cfg())

    expect(await svc.providers()).toEqual([
      {
        id: "openai",
        name: "OpenAI",
        connected: true,
        default_model: "gpt-5.4",
        models: [],
      },
    ])
  })

  test("runtime endpoints omit workspace query when caller explicitly passes undefined", async () => {
    const urls = capture_fetch([])
    const svc = createOpencodeSvc(
      cfg({
        directory: "/tmp/default-scope",
        workspace: "ws_default",
      }),
    )

    await svc.status({
      directory: "/tmp/runtime-scope",
      workspace: undefined,
    })
    await svc.last({
      session_id: "ses_1",
      directory: "/tmp/runtime-scope",
      workspace: undefined,
    })

    expect(
      urls.map((item) => {
        const url = new URL(item)
        return {
          path: url.pathname,
          directory: url.searchParams.get("directory"),
          workspace: url.searchParams.get("workspace"),
        }
      }),
    ).toEqual([
      { path: "/session/status", directory: "/tmp/runtime-scope", workspace: null },
      { path: "/session/ses_1/message", directory: "/tmp/runtime-scope", workspace: null },
    ])
  })

  test("sessions keeps config directory for undefined and omits directory when caller passes empty string", async () => {
    const urls = capture_fetch([])
    const svc = createOpencodeSvc(
      cfg({
        directory: "/tmp/default-scope",
        workspace: "ws_default",
      }),
    )

    await svc.sessions({
      directory: undefined,
      workspace: "ws_local",
      roots: true,
      limit: 8,
    })
    await svc.sessions({
      directory: "",
      workspace: "ws_local",
      roots: true,
      limit: 8,
    })

    expect(
      urls.map((item) => {
        const url = new URL(item)
        return {
          path: url.pathname,
          directory: url.searchParams.get("directory"),
          workspace: url.searchParams.get("workspace"),
          roots: url.searchParams.get("roots"),
          limit: url.searchParams.get("limit"),
        }
      }),
    ).toEqual([
      {
        path: "/session",
        directory: "/tmp/default-scope",
        workspace: "ws_local",
        roots: "true",
        limit: "8",
      },
      {
        path: "/session",
        directory: null,
        workspace: "ws_local",
        roots: "true",
        limit: "8",
      },
    ])
  })

  test("sessions forwards explicit workspace query and preserves unscoped omission", async () => {
    const urls = capture_fetch([])
    const svc = createOpencodeSvc(
      cfg({
        directory: "/tmp/default-scope",
        workspace: "ws_default",
      }),
    )

    await svc.sessions({
      directory: "/tmp/scoped",
      workspace: "ws_local",
      roots: true,
      limit: 8,
    })
    await svc.sessions({
      directory: "/tmp/unscoped",
      workspace: undefined,
      limit: 2,
    })

    expect(
      urls.map((item) => {
        const url = new URL(item)
        return {
          path: url.pathname,
          directory: url.searchParams.get("directory"),
          workspace: url.searchParams.get("workspace"),
          roots: url.searchParams.get("roots"),
          limit: url.searchParams.get("limit"),
        }
      }),
    ).toEqual([
      {
        path: "/session",
        directory: "/tmp/scoped",
        workspace: "ws_local",
        roots: "true",
        limit: "8",
      },
      {
        path: "/session",
        directory: "/tmp/unscoped",
        workspace: null,
        roots: null,
        limit: "2",
      },
    ])
  })

  test("workspaces uses experimental endpoint and normalizes fields", async () => {
    const urls: string[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        urls.push(url.toString())
        return new Response(JSON.stringify([
          {
            id: "ws_local",
            name: "Local",
            type: "git",
            branch: "main",
            current: true,
          },
          {
            workspaceID: "ws_feature",
            label: "Feature",
            kind: "git",
            gitBranch: "feat/demo",
            selected: false,
          },
        ]), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
      {
        preconnect: fetch0.preconnect.bind(fetch0),
      },
    )

    const svc = createOpencodeSvc(cfg())

    expect(
      await svc.workspaces({
        directory: "/tmp/repo",
      }),
    ).toEqual([
      {
        id: "ws_local",
        name: "Local",
        type: "git",
        branch: "main",
        current: true,
      },
      {
        id: "ws_feature",
        name: "Feature",
        type: "git",
        branch: "feat/demo",
        current: false,
      },
    ])

    const url = new URL(urls[0] ?? "")
    expect({
      path: url.pathname,
      directory: url.searchParams.get("directory"),
      workspace: url.searchParams.get("workspace"),
    }).toEqual({
      path: "/experimental/workspace",
      directory: "/tmp/repo",
      workspace: null,
    })
  })

  test("result exposes visible entries oldest-first with deterministic hash", async () => {
    const entries = ["较早完成的正式答复", "失败前仍对用户可见的说明", "后来的可见草稿"]

    mock_fetch([
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
            text: `  ${entries[0]}  `,
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
            text: "内部总结，不该进入可见历史",
            time: {
              end: 2,
            },
          },
        ],
      },
      {
        info: {
          role: "assistant",
          time: {
            completed: 3,
          },
          error: {
            name: "APIError",
            message: "boom",
          },
        },
        parts: [
          {
            type: "text",
            text: entries[1],
            time: {
              end: 3,
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
            text: entries[2],
            time: {
              end: 4,
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
            text: "Called the Read tool",
            synthetic: true,
            time: {
              end: 5,
            },
          },
        ],
      },
    ])

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.result?.({
        session_id: "ses_1",
      }),
    ).toEqual({
      state: "ok",
      text: entries[0],
      entries,
      hash: hash(entries),
      completed: false,
    })
  })

  test("result reports filtered when only hidden assistant text exists", async () => {
    mock_fetch([
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
    ])

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.result?.({
        session_id: "ses_1",
      }),
    ).toEqual({
      state: "filtered",
      completed: true,
    })
  })

  test("result reports filtered when only unfinished internal draft text exists", async () => {
    mock_fetch([
      {
        info: {
          role: "assistant",
        },
        parts: [
          {
            type: "text",
            text: "Reading /tmp/cache/image.png to inspect the attachment",
            time: {
              end: 1,
            },
            synthetic: true,
          },
        ],
      },
    ])

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.result?.({
        session_id: "ses_1",
      }),
    ).toMatchObject({
      state: "filtered",
      completed: false,
    })
  })

  test("last prefers completed user-facing text over newer partial assistant draft", async () => {
    mock_fetch([
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
            text: "最终给用户的结论",
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
            text: "我先继续读取 /tmp/cache/file.pdf 再整理一下",
            time: {
              end: 2,
            },
          },
        ],
      },
    ])

    const svc = createOpencodeSvc(cfg())
    expect(
      await svc.last({
        session_id: "ses_1",
      }),
    ).toBe("最终给用户的结论")
  })
})
