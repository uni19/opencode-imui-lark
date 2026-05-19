import type { Render, RenderOut } from "../contracts.js"

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
        title: "阶段性更新（后台仍在继续）",
        template: "green",
        state: "intermediate",
        textFormat: "markdown",
        text: input.text,
      })
    },

    final(input) {
      return card({
        title: "最终完成",
        template: "green",
        state: "final",
        textFormat: "markdown",
        text: input.text,
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
