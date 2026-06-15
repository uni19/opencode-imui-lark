import { describe, expect, test } from "bun:test"
import {
  archiveBase,
  currentTarget,
  parseArgs,
  renderInstalledEnvExample,
  renderInstallScript,
  renderPackageReadme,
  renderServiceHelperScript,
  renderServiceReadme,
  renderUninstallScript,
} from "../src/release/package.ts"

describe("release package", () => {
  test("maps host platform to supported bun target", () => {
    expect(currentTarget("darwin", "arm64")).toBe("bun-darwin-arm64")
    expect(currentTarget("linux", "x64")).toBe("bun-linux-x64")
  })

  test("parses release build args", () => {
    expect(parseArgs(["node", "app"])).toEqual({
      outdir: "dist/release",
      targets: [currentTarget()],
    })

    expect(parseArgs(["node", "app", "--target=bun-linux-x64", "--outdir", "tmp/release"])).toEqual({
      outdir: "tmp/release",
      targets: ["bun-linux-x64"],
    })
  })

  test("renders installed env template with data placeholder", () => {
    const out = renderInstalledEnvExample(["LOG_LEVEL=info", "IMUI_DB_PATH=.data/imui.db", "IMUI_DATA_DIR=", "FEISHU_MODE=stdin", ""].join("\n"))

    expect(out).toContain("IMUI_DB_PATH=__DATA_DIR__/imui.db")
    expect(out).toContain("IMUI_DATA_DIR=__DATA_DIR__")
    expect(out).toContain("Installed config template")
  })

  test("renders install and uninstall scripts with fixed config path semantics", () => {
    const install = renderInstallScript("0.1.0")
    const uninstall = renderUninstallScript()

    expect(install).toContain('cp "$ROOT/share/README-service.md" "$SHARE_DIR/README-service.md"')
    expect(install).toContain('cat > "$LIB_DIR/install.env" <<EOF')
    expect(install).toContain('if [ -f "$INSTALL_ENV" ]; then')
    expect(install).toContain('IMUI_ENV_FILE="${IMUI_ENV_FILE:-$CONFIG_DIR/.env}" exec "$LIB_DIR/$APP" "$@"')
    expect(install).not.toContain('exec "$LIB_DIR/$APP" --env-file "$CONFIG_DIR/.env" "$@"')
    expect(install).toContain('exec "$LIB_DIR/service-helper.sh" "$@"')
    expect(install).toContain('sed "s#__DATA_DIR__#$DATA_DIR#g"')
    expect(uninstall).toContain('rm -f "$BIN_DIR/$APP-service"')
    expect(uninstall).toContain('rm -f "$LIB_DIR/install.env"')
    expect(uninstall).toContain('Config and data are kept by default:')
  })

  test("renders package readme and archive name", () => {
    expect(archiveBase("0.1.0", "bun-darwin-arm64")).toBe("opencode-feishu-imui-0.1.0-bun-darwin-arm64")
    const readme = renderPackageReadme("0.1.0", "bun-darwin-arm64")
    expect(readme).toContain("./install.sh")
    expect(readme).toContain("FEISHU_MODE=long_conn")
    expect(readme).toContain("opencode-feishu-imui")
    expect(readme).toContain("opencode serve --hostname 127.0.0.1 --port 4096")
    expect(readme).toContain("opencode-feishu-imui-service install")
    expect(readme).toContain("OPENCODE_DIRECTORY=/absolute/path/to/your/working-directory")
    expect(readme).toContain("OPENCODE_WORKSPACE=wrk_xxx")
    expect(readme).not.toContain("OPENCODE_DIRECTORY=/absolute/path/to/your/worktree")
    expect(readme).toContain("- `/agent`")
    expect(readme).toContain("`/agent` 无参数时会说明当前 agent 和默认 agent；切换时使用 `/agent <agent_name>`，恢复默认使用 `/agent reset`。")
    expect(readme).toContain("- `/models`")
    expect(readme).toContain("`/models` 在 provider 信息暴露 variants 时，会在对应 model 后显示 `[variants: ...]`；只有本次展示结果里存在 variants 时，末尾才会出现切换说明。")
    expect(readme).toContain("`/model` 无参数时会说明：当 provider 暴露 variants 时，可在 `/models` 查看这些 variants；切换时使用 `/model <provider>/<model_id>@<variant>`，清除当前 variant 则直接使用 `/model <provider>/<model_id>`。")
  })

  test("renders service helper assets", () => {
    const readme = renderServiceReadme()
    const helper = renderServiceHelperScript()

    expect(readme).toContain("launchd")
    expect(readme).toContain("systemd --user")
    expect(helper).toContain('INSTALL_ENV="$LIB_DIR/install.env"')
    expect(helper).toContain('DRY_RUN="${IMUI_SERVICE_DRY_RUN:-0}"')
    expect(helper).toContain('launchd_file="$HOME/Library/LaunchAgents/com.$APP.plist"')
    expect(helper).toContain('systemd_file="$systemd_dir/$APP.service"')
    expect(helper).toContain('if [ "$DRY_RUN" != "1" ]; then')
    expect(helper).toContain('systemctl --user enable --now "$APP.service"')
    expect(helper).toContain('echo "usage: $APP-service <install|uninstall> [launchd|systemd]" >&2')
  })
})
