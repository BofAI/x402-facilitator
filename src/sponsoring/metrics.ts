import { Counter, Gauge } from "prom-client";
import { registry } from "../metrics.js";

export const sponsoringReady = new Gauge({ name: "trc20_sponsoring_ready", help: "Whether this local resource sponsor accepts work",
  labelNames: ["network"], registers: [registry] });
export const recoveryErrors = new Counter({ name: "trc20_sponsoring_recovery_errors_total", help: "Local recovery passes that failed",
  labelNames: ["network"], registers: [registry] });
export const sponsorResults = new Counter({ name: "trc20_sponsoring_results_total", help: "Sponsor execution outcomes",
  labelNames: ["network", "result"], registers: [registry] });
export const activeSponsors = new Gauge({ name: "trc20_sponsoring_active_operations", help: "Local operations awaiting resource recovery",
  labelNames: ["network"], registers: [registry] });
