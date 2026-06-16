<script setup lang="ts">
import { Sun, Moon } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useThemeStore } from "@/stores/theme";

const theme = useThemeStore();
</script>

<template>
  <Tooltip :delay-duration="0">
    <TooltipTrigger as-child>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Toggle dark mode"
        @click="theme.toggleDark()"
      >
        <Sun
          v-if="theme.isDark"
          class="size-4 rotate-0 scale-100 transition-transform duration-200"
        />
        <Moon
          v-else
          class="size-4 rotate-0 scale-100 transition-transform duration-200"
        />
      </Button>
    </TooltipTrigger>
    <TooltipContent side="bottom">
      {{ theme.isDark ? "Switch to light" : "Switch to dark" }}
    </TooltipContent>
  </Tooltip>
</template>
