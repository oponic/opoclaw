import { cleanupArtifacts } from "./artifacts.ts";
import { drainDeliveryQueue } from "./channels/delivery.ts";
import { runDueCronJobs } from "./cron.ts";
import { runDueJobs } from "./job-runner.ts";
import { recoverStaleJobs } from "./jobs.ts";
import { cleanupExpiredScopes } from "./policy.ts";

/** Run one deterministic maintenance pass; used at startup and in operations tests. */
export async function runMaintenancePass(artifactRetentionDays = 7): Promise<void> {
    await cleanupExpiredScopes();
    await recoverStaleJobs();
    await runDueJobs();
    await runDueCronJobs();
    await drainDeliveryQueue();
    await cleanupArtifacts(artifactRetentionDays * 24 * 60 * 60 * 1000);
}
