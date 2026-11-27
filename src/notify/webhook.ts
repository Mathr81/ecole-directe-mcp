/**
 * Optional notification when someone asks for access. `{ content }` is what a
 * Discord webhook expects, and n8n accepts any JSON, so one shape covers both.
 * A failure is logged and swallowed: it must never block the request itself.
 */
export type Notifier = (text: string) => Promise<void>;

export function createNotifier(url: string, fetchImpl: typeof fetch = fetch): Notifier {
  if (!url) return async () => {};
  return async (text) => {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) console.error(`Le webhook de notification a répondu ${response.status}.`);
    } catch (error) {
      console.error("Échec de l'envoi du webhook de notification :", error);
    }
  };
}
