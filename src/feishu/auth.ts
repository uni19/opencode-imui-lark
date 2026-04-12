type Input = {
  app_id?: string
  app_secret?: string
}

type Token = {
  code?: number
  msg?: string
  tenant_access_token?: string
  expire?: number
}

function err(raw: Token) {
  return raw.msg ? `feishu auth failed: ${raw.msg}` : "feishu auth failed"
}

export function createFeishuAuth(input: Input) {
  let token = ""
  let expire = 0

  return {
    enabled() {
      return !!input.app_id && !!input.app_secret
    },

    async tenant() {
      if (!input.app_id || !input.app_secret) {
        throw new Error("missing FEISHU_APP_ID or FEISHU_APP_SECRET")
      }
      if (token && Date.now() < expire - 60_000) return token

      const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          app_id: input.app_id,
          app_secret: input.app_secret,
        }),
      })

      if (!res.ok) {
        throw new Error(`feishu auth failed: ${res.status} ${res.statusText}`)
      }

      const raw = (await res.json()) as Token
      if (raw.code !== 0 || !raw.tenant_access_token || !raw.expire) {
        throw new Error(err(raw))
      }

      token = raw.tenant_access_token
      expire = Date.now() + raw.expire * 1000
      return token
    },
  }
}
