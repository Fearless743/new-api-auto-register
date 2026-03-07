import cron from "node-cron";
import { runCheckin } from "./checkin.mjs";

const CRON_EXPR = process.env.CHECKIN_CRON_EXPR || "0 0 * * *";
const CRON_TZ = process.env.CHECKIN_CRON_TZ || "Asia/Shanghai";
const RUN_ON_START = String(process.env.CHECKIN_RUN_ON_START || "false").toLowerCase() === "true";

let isRunning = false;

async function runSafely(reason) {
  if (isRunning) {
    console.log(`[定时任务] 跳过(${reason})，上一次仍在执行`);
    return;
  }

  isRunning = true;
  console.log(`[定时任务] 开始执行签到(${reason})`);

  try {
    await runCheckin();
    console.log("[定时任务] 签到执行完成");
  } catch (error) {
    console.error("[定时任务] 签到执行失败:", error);
  } finally {
    isRunning = false;
  }
}

cron.schedule(
  CRON_EXPR,
  () => {
    void runSafely("scheduled");
  },
  { timezone: CRON_TZ },
);

console.log(`[定时任务] 已启动，表达式='${CRON_EXPR}'，时区='${CRON_TZ}'`);

if (RUN_ON_START) {
  void runSafely("startup");
}
