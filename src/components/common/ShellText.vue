<script setup lang="ts">
/**
 * A short shell command in colour, inside the caller's own <pre> or <code>:
 * an install one-liner, a knock command. No gutter and no controls; the
 * surface around it already has its Copy. Same tokenizer and colours as
 * ScriptView, rendered as text nodes, and the lines joined back are `text`.
 */
import { computed } from "vue";

import { scriptLines } from "@/lib/shellTokens";
import { SHELL_TOKEN_CLASS } from "./shellTokenClass";

const props = defineProps<{ text: string }>();

const lines = computed(() => scriptLines(props.text, "shell").lines);
</script>

<template>
  <template v-for="(line, index) in lines" :key="index"><template v-if="index > 0">{{ "\n" }}</template><span v-for="(token, t) in line.tokens" :key="t" :class="SHELL_TOKEN_CLASS[token.kind]">{{ token.text }}</span></template>
</template>
