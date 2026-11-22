import { writeFileSync } from "node:fs";

const pidPath = process.env.EPX_TRAY_TEST_PID_FILE;
if (!pidPath) throw new Error("Missing EPX_TRAY_TEST_PID_FILE.");

writeFileSync(pidPath, String(process.pid));
await Bun.sleep(30_000);
