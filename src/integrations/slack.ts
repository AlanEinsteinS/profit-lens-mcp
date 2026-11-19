/**
 * Minimal Slack incoming-webhook client. Only `https://hooks.slack.com/` URLs
 * are accepted, so a misconfigured env var can never turn this into a
 * request to an arbitrary host.
 */

export const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/';

export function isValidSlackWebhookUrl(url: string): boolean {
  return url.startsWith(SLACK_WEBHOOK_PREFIX) && URL.canParse(url);
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

export async function postSlackMessage(
  webhookUrl: string,
  text: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (!isValidSlackWebhookUrl(webhookUrl)) {
    throw new Error(`SLACK_WEBHOOK_URL must start with ${SLACK_WEBHOOK_PREFIX}`);
  }
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, mrkdwn: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // Never echo the webhook URL: it is a secret.
    throw new Error(`Slack webhook returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}
