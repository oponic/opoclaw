import { unlinkSync, writeFileSync, mkdirSync } from "fs";
import { exec } from "../utils.ts";
import { OP_DIR } from "../channels/shared.ts";
import { getOS } from "./gateway.ts";
import { BIN_DIR, OPCLAW_BIN, OPCLAW_BIN_WIN, PLIST_PATH_LA, SYSTEMD_PATH } from "./paths.ts";
import { info, ok, warn, cmdStyle, value, chip, subtle } from "./output.ts";
import { gatewayStop } from "./gateway.ts";

export function installService() {
  const os = getOS();
  info(`Installing ${os} service...`);

  switch (os) {
    case "macos": {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.oponic.opoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${OPCLAW_BIN}</string>
        <string>gateway</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${OP_DIR}/logs/gateway.log</string>
    <key>StandardErrorPath</key>
    <string>${OP_DIR}/logs/gateway.log</string>
    <key>WorkingDirectory</key>
    <string>${OP_DIR}</string>
</dict>
</plist>`;
      mkdirSync(`${OP_DIR}/logs`, { recursive: true });
      writeFileSync(PLIST_PATH_LA, plist);
      exec(`launchctl load ${PLIST_PATH_LA}`);
      ok(`macOS service installed.`);
      console.log(`${chip("MANAGE", "green")}`);
      console.log(`  ${cmdStyle("launchctl start/com.oponic.opoclaw")}`);
      console.log(`  ${cmdStyle("launchctl stop/com.oponic.opoclaw")}`);
      break;
    }
    case "linux": {
      const unit = `[Unit]
Description=opoclaw AI Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${exec("whoami")}
WorkingDirectory=${OP_DIR}
ExecStart=${OPCLAW_BIN} gateway start
Restart=on-failure
RestartSec=5
StandardOutput=append:${OP_DIR}/logs/gateway.log
StandardError=append:${OP_DIR}/logs/gateway.log

[Install]
WantedBy=multi-user.target`;
      mkdirSync(`${OP_DIR}/logs`, { recursive: true });
      writeFileSync(SYSTEMD_PATH, unit);
      exec("sudo systemctl daemon-reload");
      exec("sudo systemctl enable opoclaw.service");
      exec("sudo systemctl start opoclaw.service");
      ok("Linux systemd service installed and started");
      console.log(`${chip("MANAGE", "green")}`);
      console.log(`  ${cmdStyle("systemctl status opoclaw")}`);
      console.log(`  ${cmdStyle("systemctl stop opoclaw")}`);
      break;
    }
    case "windows": {
      warn("Windows service: create manually with NSSM or sc.exe.");
      console.log(`${chip("WINDOWS SERVICE", "yellow")}`);
      console.log(`  ${cmdStyle(`nssm install opoclaw "${OPCLAW_BIN}" gateway start`)}`);
      console.log(`  ${cmdStyle(`sc create opoclaw binPath="${OPCLAW_BIN} gateway start"`)}`);
      break;
    }
  }
}

export function uninstallService() {
  const os = getOS();
  info(`Removing ${os} service...`);

  switch (os) {
    case "macos": {
      try {
        exec(`launchctl unload ${PLIST_PATH_LA} 2>/dev/null || true`);
        unlinkSync(PLIST_PATH_LA);
        ok("macOS service removed");
      } catch { warn("No service found"); }
      break;
    }
    case "linux": {
      try {
        exec("sudo systemctl stop opoclaw.service 2>/dev/null || true");
        exec("sudo systemctl disable opoclaw.service 2>/dev/null || true");
        exec("sudo rm -f /etc/systemd/system/opoclaw.service");
        exec("sudo systemctl daemon-reload");
        ok("Linux service removed");
      } catch { warn("No service found"); }
      break;
    }
    case "windows": {
      try {
        exec("nssm remove opoclaw confirm 2>nul || true");
        exec("sc delete opoclaw 2>nul || true");
        ok("Windows service removed");
      } catch { warn("No service found"); }
      break;
    }
  }
}

export function fullUninstall() {
  info("Uninstalling opoclaw...");
  gatewayStop();
  uninstallService();
  try { unlinkSync(OPCLAW_BIN); } catch {}
  try { unlinkSync(OPCLAW_BIN_WIN); } catch {}
  ok("opoclaw uninstalled.");
  console.log(`\n${chip("DATA", "red")}`);
  console.log(`  ${value("To remove all data, delete:")} ${cmdStyle(OP_DIR)}`);
  console.log(`  ${subtle("(config.toml, workspace, and usage data will be lost)")}\n`);
}