/**
 * The one fixture the fake modules share. Both fakeApi.ts and
 * fakeGuardReality.ts mutate it (a filed plan adds an approval, a scope change
 * moves a node), so it has to be a single instance.
 */
import { buildFixture } from "./sshGuardFixture";

export const state = buildFixture();
