import type { Render, RenderOut } from "../contracts.js"

const text = (body: string): RenderOut => ({
  kind: "text",
  body: {
    text: body,
  },
})

const card = (body: Record<string, unknown>): RenderOut => ({
  kind: "card",
  body,
})

export function createRender(): Render {
  return {
    ack(input) {
      return card({
        title: "OpenCode",
        template: "wathet",
        text: `已收到：${input.text}`,
      })
    },

    progress(input) {
      return card({
        title: "OpenCode",
        template: "blue",
        step: input.step,
        text: input.text,
      })
    },

    approval(input) {
      return card({
        type: "approval",
        title: "权限审批",
        req: input.req,
        tool: input.tool,
        detail: input.detail,
      })
    },

    question(input) {
      return card({
        type: "question",
        title: input.title,
        req: input.req,
        options: input.opts ?? [],
        custom: input.custom ?? true,
      })
    },

    intermediate(input) {
      return card({
        title: "OpenCode",
        template: "green",
        state: "intermediate",
        text: [`阶段性更新（后台仍在继续）`, input.text].join("\n\n"),
      })
    },

    final(input) {
      return card({
        title: "OpenCode",
        template: "green",
        state: "final",
        text: [`最终完成`, input.text].join("\n\n"),
      })
    },

    err(input) {
      return card({
        title: "OpenCode",
        template: "red",
        text: `出错了：${input.text}`,
      })
    },
  }
}
