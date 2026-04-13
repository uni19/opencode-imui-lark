import { cfg } from "../app/cfg.js"
import { loadAppEnv } from "../app/env.js"
import { validateAppCfg } from "../app/validate.js"

export async function doctor(argv = process.argv) {
  const env = await loadAppEnv({ argv })
  const conf = cfg()
  const report = validateAppCfg(conf)

  console.log(
    JSON.stringify({
      type: "release.doctor",
      env,
      ok: report.ok,
      warnings: report.warnings,
      errors: report.errors,
    }),
  )

  return report
}

if (import.meta.main) {
  const out = await doctor()
  process.exit(out.ok ? 0 : 1)
}
