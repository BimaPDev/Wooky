import { PairRequest, PairResponse, PairingCodeText } from "@wooky/contracts";
import { browserDeviceName, browserPlatform, pairDeviceId } from "./device.ts";
import { savePairedToken } from "./token.ts";

export type PairOutcome = { ok: true; hostName: string } | { ok: false; message: string };

/** Pairs this browser with the host that served the page. The token stays in this browser. */
export async function pairWithHost(
  rawCode: string,
  name: string,
  fetcher: typeof fetch = fetch,
): Promise<PairOutcome> {
  const code = PairingCodeText.safeParse(rawCode.replace(/\s+/g, ""));
  if (!code.success) return { ok: false, message: "Expected an 8-character pairing code." };
  const body = PairRequest.safeParse({
    code: code.data,
    device: {
      deviceId: pairDeviceId(),
      name: name.trim() || browserDeviceName(),
      platform: browserPlatform(),
      version: "web",
    },
  });
  if (!body.success) return { ok: false, message: "Could not build the pairing request." };
  let response: Response;
  try {
    response = await fetcher("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.data),
    });
  } catch {
    return { ok: false, message: "Could not reach this host." };
  }
  if (!response.ok) return { ok: false, message: await failureMessage(response) };
  const parsed = PairResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { ok: false, message: "The host sent an unexpected answer." };
  if (!savePairedToken(parsed.data.token)) {
    return { ok: false, message: "This browser could not keep the pairing. Allow site storage and try again." };
  }
  return { ok: true, hostName: parsed.data.host.name };
}

async function failureMessage(response: Response): Promise<string> {
  if (response.status === 429) return "Too many wrong codes. Wait a minute and try again.";
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return "That code is wrong, used, or expired. Show a new one on the host.";
  }
  return `The host answered ${response.status}.`;
}
