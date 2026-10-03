/**
 * What Publishing needs to say about the identity links it lists beside the
 * shares: who owns each one, what it serves now, and when a client last
 * fetched it.
 *
 * The routes come from the page's publishing read (one row per issued link,
 * no token). The rest is two reads Publishing does not own, done only while
 * the Routes layer shows those rows and again on the page's Refresh, never on
 * the 30 s poll: the status (GET /api/vpn/users/<id>/link, one per link,
 * which wants vpncore:admin and an unrestricted allowlist) and the owner's
 * address, through vpn-core's users/list on the plugin call path, the read its
 * Users page and the command palette use. Without either the rows still show
 * the route; they never guess at what they could not read.
 */
import { computed, ref, shallowRef, watch } from "vue";

import { api, ApiError, type IdentityLinkStatus } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { usePluginContributions } from "@/composables/usePluginContributions";
import {
  VPN_CORE_PLUGIN_ID,
  VPN_USERS_SERVICE,
  paletteIdentities,
  type PaletteIdentity,
} from "@/components/common/commandPaletteModel";

/** One link's status read: the answer, or why there is none. */
export type IdentityLinkRead =
  | { status: IdentityLinkStatus }
  | { error: string; code: string; httpStatus: number };

/** At most this many status reads in flight, so a long identity list does not burst the server. */
const STATUS_CONCURRENCY = 4;

export function useIdentityLinks(options: {
  /** The identity ids the page's routes carry a link for. */
  ids: () => readonly string[];
  /** The rows are on screen. */
  active: () => boolean;
}) {
  const auth = useAuthStore();
  const { navContributions } = usePluginContributions();

  /** vpn-core's Users page, when this principal may open it: where a link is edited. */
  const usersPage = computed(() =>
    navContributions.value.find((entry) => entry.pluginId === VPN_CORE_PLUGIN_ID && entry.route === "users"),
  );
  const canReadStatus = computed(() => auth.can("vpncore:admin"));

  const statuses = shallowRef<ReadonlyMap<string, IdentityLinkRead>>(new Map());
  /** By identity id; undefined while unread or unreadable. */
  const identities = shallowRef<ReadonlyMap<string, PaletteIdentity> | undefined>(undefined);
  const loading = ref(false);
  /** The id list the last read covered, so the 30 s routes poll does not read again. */
  let readKey = "";
  let generation = 0;

  async function readStatus(id: string): Promise<IdentityLinkRead> {
    try {
      return { status: await api.vpnLinks.get(id) };
    } catch (error) {
      if (error instanceof ApiError) return { error: error.serverMessage || error.message, code: error.code, httpStatus: error.status };
      return { error: error instanceof Error ? error.message : String(error), code: "", httpStatus: 0 };
    }
  }

  async function readStatuses(ids: readonly string[]): Promise<Map<string, IdentityLinkRead>> {
    const out = new Map<string, IdentityLinkRead>();
    let next = 0;
    async function worker(): Promise<void> {
      for (let id = ids[next++]; id !== undefined; id = ids[next++]) {
        out.set(id, await readStatus(id));
      }
    }
    await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, ids.length) }, worker));
    return out;
  }

  async function readIdentities(): Promise<Map<string, PaletteIdentity> | undefined> {
    if (!usersPage.value) return undefined;
    try {
      const list = paletteIdentities(await api.plugins.call(VPN_CORE_PLUGIN_ID, VPN_USERS_SERVICE, "list"));
      return new Map(list.map((identity) => [identity.id, identity]));
    } catch {
      return undefined;
    }
  }

  async function refresh(): Promise<void> {
    const ids = [...options.ids()];
    readKey = ids.join(",");
    const mine = ++generation;
    if (!ids.length) {
      statuses.value = new Map();
      return;
    }
    loading.value = true;
    try {
      const [nextStatuses, nextIdentities] = await Promise.all([
        canReadStatus.value ? readStatuses(ids) : Promise.resolve(new Map<string, IdentityLinkRead>()),
        readIdentities(),
      ]);
      // A newer read (a Refresh, a changed list) owns the answer.
      if (mine !== generation) return;
      statuses.value = nextStatuses;
      if (nextIdentities || !usersPage.value) identities.value = nextIdentities;
    } finally {
      if (mine === generation) loading.value = false;
    }
  }

  watch(
    () => [options.active(), options.ids().join(",")] as const,
    ([on, key]) => {
      if (on && key !== readKey) void refresh();
    },
    { immediate: true },
  );
  // vpn-core's page settles after the contributions read; the owners are then
  // worth asking for once. The statuses do not depend on it and are not read again.
  watch(
    () => !!usersPage.value,
    async (has) => {
      if (!has || !options.active() || !options.ids().length || identities.value) return;
      const mine = generation;
      const next = await readIdentities();
      if (mine === generation && next) identities.value = next;
    },
  );

  return { statuses, identities, loading, usersPage, canReadStatus, refresh };
}
