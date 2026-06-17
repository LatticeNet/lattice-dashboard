<script setup lang="ts">
import { computed, type Component } from "vue";
import {
  CheckCircle2,
  Circle,
  Server,
  Activity,
  DoorOpen,
  KeyRound,
  Sparkles,
} from "lucide-vue-next";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const props = defineProps<{
  nodeCount: number;
  twoFactorEnabled?: boolean;
  monitorCount?: number;
  proxyInboundCount?: number;
}>();

const auth = useAuthStore();

type Step = {
  key: string;
  icon: Component;
  title: string;
  description: string;
  to: string;
  cta: string;
  done: boolean;
  /** When false the action button is hidden (principal lacks the scope). */
  allowed: boolean;
};

const steps = computed<Step[]>(() => [
  {
    key: "enroll-node",
    icon: Server,
    title: "Enroll your first node",
    description: "Generate an enrollment token and bring an agent online.",
    to: "/nodes",
    cta: "Enroll node",
    done: props.nodeCount > 0,
    allowed: auth.can("node:admin"),
  },
  {
    key: "service-monitor",
    icon: Activity,
    title: "Add a service monitor",
    description: "Track uptime and latency for the things that matter.",
    to: "/monitoring",
    cta: "Add monitor",
    done: !!props.monitorCount && props.monitorCount > 0,
    allowed: true,
  },
  {
    key: "proxy-inbound",
    icon: DoorOpen,
    title: "Set up a proxy inbound",
    description: "Expose a secure entry point for your proxy traffic.",
    to: "/proxy/inbounds",
    cta: "Add inbound",
    done: !!props.proxyInboundCount && props.proxyInboundCount > 0,
    allowed: auth.can("proxy:admin"),
  },
  {
    key: "two-factor",
    icon: KeyRound,
    title: "Secure your account with 2FA",
    description: "Add a second factor to protect operator access.",
    to: "/settings/security",
    cta: "Enable 2FA",
    done: !!props.twoFactorEnabled,
    allowed: true,
  },
]);

const doneCount = computed(() => steps.value.filter((s) => s.done).length);
const totalCount = computed(() => steps.value.length);

/** First not-done step is the primary call to action. */
const primaryKey = computed(() => steps.value.find((s) => !s.done)?.key);
</script>

<template>
  <Card class="overflow-hidden">
    <!-- Branded hero header -->
    <div class="relative overflow-hidden border-b border-border bg-primary/5 lattice-grid">
      <div
        class="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-primary/15 blur-3xl"
        aria-hidden="true"
      />
      <div class="relative flex items-start justify-between gap-4 p-6">
        <div class="space-y-1.5">
          <div class="flex items-center gap-2">
            <span
              class="flex size-8 items-center justify-center rounded-lg border border-border bg-card text-primary shadow-sm"
            >
              <Sparkles class="size-4" />
            </span>
            <h2 class="text-lg font-semibold tracking-tight">Welcome to Lattice</h2>
          </div>
          <p class="text-sm text-muted-foreground">
            Bring your fleet online and lock things down in a few steps.
          </p>
        </div>
        <Badge variant="secondary" class="shrink-0 tabular">
          {{ doneCount }} of {{ totalCount }} done
        </Badge>
      </div>
    </div>

    <CardContent class="p-0">
      <ul class="divide-y divide-border">
        <li
          v-for="step in steps"
          :key="step.key"
          class="flex items-center gap-4 p-4 sm:px-6"
        >
          <component
            :is="step.done ? CheckCircle2 : Circle"
            :class="cn('size-5 shrink-0', step.done ? 'text-success' : 'text-muted-foreground')"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-2 text-sm font-medium">
              <component :is="step.icon" class="size-4 text-muted-foreground" aria-hidden="true" />
              <span class="truncate">{{ step.title }}</span>
            </p>
            <p class="mt-0.5 text-sm text-muted-foreground">{{ step.description }}</p>
          </div>
          <div class="shrink-0">
            <Button
              v-if="step.allowed && !step.done"
              as-child
              size="sm"
              :variant="step.key === primaryKey ? 'default' : 'outline'"
            >
              <RouterLink :to="step.to">{{ step.cta }}</RouterLink>
            </Button>
            <Badge v-else-if="step.done" variant="success" class="shrink-0">Done</Badge>
          </div>
        </li>
      </ul>
    </CardContent>
  </Card>
</template>
