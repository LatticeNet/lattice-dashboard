import { createApp } from "vue";
import { createPinia } from "pinia";

import App from "./App.vue";
import router from "./router";
import { useThemeStore } from "./stores/theme";

import "./style/app.css";

const app = createApp(App);

const pinia = createPinia();
app.use(pinia);

// Lock the brand palette to the surface theme before the first paint of mounted
// content. Light/dark was already pre-painted by /theme-init.js.
useThemeStore().init();

app.use(router);
app.mount("#app");
