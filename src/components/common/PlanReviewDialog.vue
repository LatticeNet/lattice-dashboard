<script setup lang="ts">
import { ExternalLink, RefreshCw } from "lucide-vue-next";
import { RouterLink } from "vue-router";
import { cn } from "@/lib/utils";

import CopyButton from "@/components/common/CopyButton.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * PlanReviewDialog — DRY home for the `plan -> approve -> apply` review dialog
 * copy-pasted across the safety-critical mutation views (Guard, DNS, Policy,
 * Tunnels, WireGuard, GeoRouting, Profiles, AgentUpdates, Approvals).
 *
 * ── SECURITY-CRITICAL CONTRACT ────────────────────────────────────────────────
 * This component is a PURE RENDERER. It never hashes, never mutates, never calls
 * the API. The caller computes the SHA-256 digest (via `usePlanDigest`) over the
 * EXACT bytes it passes here as `planText`, then passes that hex string as
 * `digest`. Because the digest the operator reads is rendered from the same
 * `digest` prop that the caller binds the approval to — and that digest was
 * derived from the same `planText` string shown in the <pre> — the displayed
 * digest provably matches the bytes the approval will bind. Do NOT re-derive the
 * digest in this component; doing so could desync displayed-vs-bound bytes.
 *
 * The plan body is rendered with plain text interpolation inside a <pre> (NOT
 * v-html) to stay CSP-safe with untrusted plan content.
 *
 * All user-facing copy is exposed as props with plain-English defaults so callers
 * can pass translated strings (via vue-i18n `t(...)`) without this component
 * importing any locale.
 */

interface BadgeSpec {
  /** Visible label text (plain text — never rendered as HTML). */
  label: string;
  /** Badge variant; defaults to "outline" when omitted. */
  variant?:
    | "default"
    | "secondary"
    | "destructive"
    | "outline"
    | "success"
    | "warning"
    | "info";
}

const props = withDefaults(
  defineProps<{
    /** v-model:open — controls dialog visibility. */
    open: boolean;
    /**
     * The exact plan/diff text the operator reviews AND the bytes the caller
     * hashed to produce `digest`. Rendered verbatim as text (CSP-safe).
     */
    planText?: string | null;
    /**
     * Pre-computed SHA-256 hex digest of `planText`, supplied by the caller
     * (e.g. from `usePlanDigest().digestFor(...)`). Rendered as-is; never
     * recomputed here. Must derive from the same bytes as `planText`.
     */
    digest?: string | null;
    /** Disables the approve action and shows a spinner while a mutation runs. */
    busy?: boolean;
    /**
     * When true, render the primary approve button (emits `approve`). When
     * false (default), only the Approvals CTA is shown — for views that hand
     * off to the Approvals inbox rather than approving inline.
     */
    showApprove?: boolean;
    /**
     * Optional default badges (action/scope/status) rendered when the `#badges`
     * slot is not used. Each is plain text.
     */
    badges?: BadgeSpec[];

    // ── Copy (English defaults; pass t(...) to localize) ──────────────────────
    title?: string;
    description?: string;
    planLabel?: string;
    digestLabel?: string;
    copyDigestLabel?: string;
    closeLabel?: string;
    approveLabel?: string;
    approvalsLabel?: string;
    /** Target route for the "go to approvals" CTA. */
    approvalsTo?: string;
  }>(),
  {
    planText: "",
    digest: "",
    busy: false,
    showApprove: false,
    badges: () => [],
    title: "Plan created",
    description:
      "Review the plan and its digest below, then approve or open the approvals inbox to apply it.",
    planLabel: "Plan",
    digestLabel: "sha256",
    copyDigestLabel: "Copy digest",
    closeLabel: "Close",
    approveLabel: "Approve",
    approvalsLabel: "Go to approvals",
    approvalsTo: "/approvals",
  },
);

const emit = defineEmits<{
  /** v-model:open update. */
  "update:open": [value: boolean];
  /** Operator confirmed approval. Caller performs the mutation. */
  approve: [];
  /** Operator dismissed the dialog without approving. */
  cancel: [];
}>();

function setOpen(value: boolean) {
  emit("update:open", value);
  if (!value) emit("cancel");
}
</script>

<template>
  <Dialog :open="props.open" @update:open="setOpen">
    <DialogScrollContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ props.title }}</DialogTitle>
        <DialogDescription>{{ props.description }}</DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <!-- Action / scope / status badges -->
        <div
          v-if="$slots.badges || props.badges.length"
          class="flex flex-wrap items-center gap-2"
        >
          <slot name="badges">
            <Badge
              v-for="(badge, index) in props.badges"
              :key="index"
              :variant="badge.variant ?? 'outline'"
            >
              {{ badge.label }}
            </Badge>
          </slot>
        </div>

        <!-- Plan diff (CSP-safe text — NOT v-html) -->
        <div class="rounded-md border border-border">
          <div
            class="flex items-center justify-between gap-3 border-b border-border px-3 py-2"
          >
            <span class="text-sm font-medium">{{ props.planLabel }}</span>
            <CopyButton :value="props.planText || ''" />
          </div>
          <pre
            class="max-h-[420px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed"
          >{{ props.planText }}</pre>
        </div>

        <!-- SHA-256 digest binding (rendered from the same bytes the approval binds) -->
        <div
          v-if="props.digest"
          class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3 text-xs"
        >
          <span class="font-medium">{{ props.digestLabel }}</span>
          <code class="break-all font-mono">{{ props.digest }}</code>
          <CopyButton :value="props.digest" :label="props.copyDigestLabel" />
        </div>

        <slot />
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" @click="setOpen(false)">
          {{ props.closeLabel }}
        </Button>
        <Button
          v-if="props.showApprove"
          type="button"
          :disabled="props.busy"
          @click="emit('approve')"
        >
          <RefreshCw
            v-if="props.busy"
            :class="cn('size-4 animate-spin')"
            aria-hidden="true"
          />
          {{ props.approveLabel }}
        </Button>
        <Button v-else as-child>
          <RouterLink :to="props.approvalsTo">
            <ExternalLink class="size-4" aria-hidden="true" />
            {{ props.approvalsLabel }}
          </RouterLink>
        </Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>
