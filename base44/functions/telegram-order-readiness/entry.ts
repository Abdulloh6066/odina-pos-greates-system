import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";
import config from "../../shared/order-bot/readiness-config.json" with { type: "json" };
import { prepareOrderBotReadiness } from "../../shared/order-bot/readiness.js";
// readiness-v5: only fixed runtime cause labels; no raw error text.
export default async function (req: Request): Promise<Response> {
    return prepareOrderBotReadiness({
        clientForRequest: createClientFromRequest,
        readSecret: (name: string) => secrets.get(name),
        fetchImpl: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
        verificationApproved: config.verificationApproved,
        ownerStaffId: config.ownerStaffId, expectedWebhookUrl: config.expectedWebhookUrl,
    })(req);
}
