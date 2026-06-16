<script setup lang="ts">
// Root component. The authenticated shell (sidebar/header/Toaster) lives in
// layout/AppLayout.vue; the /login route renders outside the shell. Keeping the
// root minimal lets vue-router own the top-level surface.
import { RouterView } from "vue-router";
</script>

<template>
  <RouterView />
</template>
