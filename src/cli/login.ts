import type { EcoleDirecteClient, LoginCredentials, Session } from '../client/types.js';

export interface LoginIO {
  chooseAnswer(question: string, propositions: string[]): Promise<string>;
}

export async function runLoginFlow(
  client: EcoleDirecteClient,
  io: LoginIO,
  credentials: LoginCredentials,
): Promise<Session> {
  const result = await client.login(credentials);
  if ('accessToken' in result) return result;
  const answer = await io.chooseAnswer(result.question, result.propositions);
  return client.completeTwoFactor(result, answer, credentials);
}
