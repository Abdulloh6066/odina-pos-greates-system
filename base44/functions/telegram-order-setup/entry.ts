import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";
import { prepareOrderBotSetup } from "../../shared/order-bot/setup.js";
export default async function (req: Request): Promise<Response> {
    return prepareOrderBotSetup({ clientForRequest: createClientFromRequest, readSecret: (name: string) => secrets.get(name), fetchImpl: (url: string, init?: RequestInit) => globalThis.fetch(url, init) })(req);
}
