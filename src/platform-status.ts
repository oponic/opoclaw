import { listJobs } from "./jobs.ts";
import { listOutboundDeliveries } from "./channels/delivery.ts";
import { getRollingCost } from "./usage.ts";
import type { OpoclawConfig } from "./config.ts";

/** A compact operational snapshot shared by doctor, activity, and channel status views. */
export async function getPlatformStatus(config: OpoclawConfig) {
    const [jobs, deliveries, rollingCost] = await Promise.all([
        listJobs(),
        listOutboundDeliveries(),
        getRollingCost(),
    ]);
    return {
        jobs: {
            pending: jobs.filter((job) => job.status === "pending").length,
            running: jobs.filter((job) => job.status === "running").length,
            failed: jobs.filter((job) => job.status === "failed").length,
        },
        deliveries: {
            pending: deliveries.filter((delivery) => delivery.status === "pending").length,
            failed: deliveries.filter((delivery) => delivery.status === "failed").length,
        },
        budgets: {
            rollingCost,
            hardLimit: config.usage_alerts?.hard_limit ?? null,
            withinHardLimit: config.usage_alerts?.hard_limit === undefined || rollingCost < config.usage_alerts.hard_limit,
        },
        channels: {
            discord: !!config.channel?.discord?.enabled,
            signal: !!config.channel?.signal?.enabled,
            irc: !!config.channel?.irc?.enabled,
            openai: !!config.channel?.openai?.enabled,
        },
    };
}
