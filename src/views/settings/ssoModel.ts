/**
 * Who an identity provider delete can lock out (design 23, section 3.8).
 *
 * An account with no password signs in only through single sign-on or a
 * passkey. The user list does not say which provider an account came
 * through, so with another enabled provider left each such account is
 * named with "if it signs in through this one"; with none left, every such
 * account loses single sign-on.
 *
 * The confirm never says nobody is affected unless the account list was read
 * and holds no account without a password. While the list is being read the
 * confirm waits; when it could not be read, or the caller may not read it,
 * the confirm says so and asks for the typed name.
 */

export type ProviderDeleteLine =
  | { kind: "keep" }
  | { kind: "locked"; user: string }
  | { kind: "maybeLocked"; user: string }
  | { kind: "usersReading" }
  | { kind: "usersUnread" }
  | { kind: "usersNoAccess" };

export interface ProviderDeleteImpact {
  lines: ProviderDeleteLine[];
  /** The operator types the provider's name before Delete enables. */
  typed: boolean;
  /** The account list is still being read: Delete stays disabled. */
  waiting: boolean;
}

export interface ProviderDeleteInput {
  targetId: string;
  providers: ReadonlyArray<{ id: string; enabled: boolean }>;
  /** The accounts as last read in this dialog, or undefined when no read landed. */
  users: ReadonlyArray<{ username: string; has_password: boolean }> | undefined;
  canReadUsers: boolean;
  /** A read of the accounts is running for this dialog. */
  usersReading: boolean;
}

export function providerDeleteImpact(input: ProviderDeleteInput): ProviderDeleteImpact {
  const lines: ProviderDeleteLine[] = [{ kind: "keep" }];
  if (!input.canReadUsers) return { lines: [...lines, { kind: "usersNoAccess" }], typed: true, waiting: false };
  if (input.usersReading) return { lines: [...lines, { kind: "usersReading" }], typed: true, waiting: true };
  if (!input.users) return { lines: [...lines, { kind: "usersUnread" }], typed: true, waiting: false };
  const othersLeft = input.providers.some((provider) => provider.id !== input.targetId && provider.enabled);
  const passwordless = input.users
    .filter((user) => !user.has_password)
    .map((user) => user.username)
    .sort((a, b) => a.localeCompare(b));
  for (const user of passwordless) lines.push(othersLeft ? { kind: "maybeLocked", user } : { kind: "locked", user });
  return { lines, typed: passwordless.length > 0, waiting: false };
}
