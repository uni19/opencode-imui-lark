import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { archiveBase, currentTarget } from "./package.js"

type SmokeArgs = {
  artifact?: string
  outdir: string
}

function fail(msg: string): never {
  throw new Error(msg)
}

function run(cmd: string[], cwd?: string, env?: Record<string, string>) {
  const out = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    stdio: "inherit",
    env: env ? { ...process.env, ...env } : process.env,
  })
  if (out.status !== 0) fail(`${cmd.join(" ")} failed`)
}

export function parseArgs(argv = process.argv): SmokeArgs {
  const args = argv.slice(2)
  let artifact: string | undefined
  let outdir = path.join("dist", "release")

  for (let i = 0; i < args.length; i++) {
    const item = args[i]
    if (!item) continue
    if (item === "--artifact") {
      artifact = args[++i]
      if (!artifact) fail("missing value for --artifact")
      continue
    }
    if (item.startsWith("--artifact=")) {
      artifact = item.slice("--artifact=".length)
      continue
    }
    if (item === "--outdir") {
      const value = args[++i]
      if (!value) fail("missing value for --outdir")
      outdir = value
      continue
    }
    if (item.startsWith("--outdir=")) {
      outdir = item.slice("--outdir=".length)
      continue
    }
    fail(`unknown option: ${item}`)
  }

  return {
    artifact,
    outdir,
  }
}

export async function defaultArtifact(root = process.cwd(), outdir = path.join("dist", "release")) {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version?: string }
  const version = pkg.version ?? "0.1.0"
  const base = archiveBase(version, currentTarget())
  const dir = path.resolve(root, outdir)
  const list = (await readdir(dir))
    .filter((item) => item === `${base}.tar.gz` || (item.startsWith(`${base}-`) && item.endsWith(".tar.gz")))
    .map((item) => path.join(dir, item))

  if (list.length === 0) {
    return path.join(dir, `${base}.tar.gz`)
  }

  const ranked = await Promise.all(
    list.map(async (item) => ({
      item,
      mtime: (await stat(item)).mtimeMs,
    })),
  )
  ranked.sort((a, b) => b.mtime - a.mtime)
  return ranked[0]!.item
}

export function serviceManager(platform = process.platform) {
  if (platform === "darwin") return "launchd"
  if (platform === "linux") return "systemd"
  return fail(`unsupported smoke platform: ${platform}`)
}

export function serviceFile(home: string, platform = process.platform) {
  if (platform === "darwin") return path.join(home, "Library", "LaunchAgents", "com.opencode-feishu-imui.plist")
  if (platform === "linux") return path.join(home, ".config", "systemd", "user", "opencode-feishu-imui.service")
  return fail(`unsupported smoke platform: ${platform}`)
}

export async function smoke(root = process.cwd(), argv = process.argv) {
  const args = parseArgs(argv)
  const artifact = args.artifact ? path.resolve(root, args.artifact) : await defaultArtifact(root, args.outdir)

  if (!existsSync(artifact)) fail(`artifact not found: ${artifact}`)

  const work = await mkdtemp(path.join(tmpdir(), "oc-feishu-smoke-"))
  const home = path.join(work, "home")
  const prefix = path.join(work, "prefix")
  const configDir = path.join(work, "config")
  const dataDir = path.join(work, "data")
  const manager = serviceManager()
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    PREFIX: prefix,
    CONFIG_DIR: configDir,
    DATA_DIR: dataDir,
    IMUI_SERVICE_DRY_RUN: "1",
  }

  try {
    run(["tar", "-xzf", artifact], work)
    const items = await readdir(work)
    const base = items.find((item) => item.startsWith("opencode-feishu-imui-") && !item.endsWith(".tar.gz"))
    if (!base) fail("smoke unpack failed: package directory not found")
    const stage = path.join(work, base)
    const bin = path.join(prefix, "bin", "opencode-feishu-imui")
    const service = path.join(prefix, "bin", "opencode-feishu-imui-service")

    run(["./install.sh"], stage, env)
    if (!existsSync(bin)) fail("installed binary not found")
    if (!existsSync(service)) fail("installed service helper not found")
    if (!existsSync(path.join(configDir, ".env"))) fail("installed config file not found")

    run([bin, "--help"], root, env)
    run([service, "install", manager], root, env)
    if (!existsSync(serviceFile(home))) fail("service file not found after helper install")
    run([service, "uninstall", manager], root, env)
    if (existsSync(serviceFile(home))) fail("service file still exists after helper uninstall")

    run(["./uninstall.sh"], stage, env)
    if (existsSync(bin)) fail("installed binary still exists after uninstall")

    return {
      ok: true,
      artifact,
      manager,
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const out = await smoke()
  console.log(JSON.stringify(out))
}
