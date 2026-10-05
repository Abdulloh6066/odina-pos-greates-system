import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";
import config from "../../shared/order-bot/readiness-config.json" with { type: "json" };
import { prepareOrderBotReadiness } from "../../shared/order-bot/readiness.js";
// readiness-v2: sanitized stage codes; refresh only this function bundle.
export default async function (req: Request): Promise<Response> {
    return prepareOrderBotReadiness({
        clientForRequest: createClientFromRequest,
        readSecret: (name: string) => secrets.get(name), fetchImpl: fetch,
        verificationApproved: config.verificationApproved,
        ownerStaffId: config.ownerStaffId, expectedWebhookUrl: config.expectedWebhookUrl,
    })(req);
}
